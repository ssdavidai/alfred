// AgentPhone — tenant-side ctrl-api routes.
//
//   Phase 4 (#449)  GET  /api/v1/phone/voice-context   — bridge primer bundle
//   Phase 4 (#449)  POST /api/v1/phone/transcript      — call transcript ingest
//   Phase 5 (#222)  POST /api/v1/phone/sms/inbound     — SaaS-forwarded SMS
//   Phase 5 (#222)  CRUD /api/v1/phone/authorized-numbers
//   Phase 6 (#224)  POST /api/v1/phone/sms             — outbound SMS
//   Phase 6 (#224)  POST /api/v1/phone/call            — outbound call

import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";

// Defaults match the merged single-VM stack's ctrl-api mounts: vault at
// /vault (vault_data volume) and alfred-data at /alfred-data (alfred_data
// volume). Env-var overrides are honoured. Skills + SOUL/MEMORY are resolved
// separately below — see the split comment on SKILLS_DIR.
const VAULT_PATH = process.env.VAULT_PATH ?? "/vault";
const STREAMS_DIR = `${process.env.ALFRED_DATA_DIR ?? "/alfred-data"}/streams`;

// Skills vs SOUL/MEMORY split (merged single-VM stack — no openclaw mount):
//   * SKILLS (alfred-composio-*, alfred-voice) live under the Hermes
//     per-profile workspace skills dir — the SAME location integrations.ts
//     WRITES them to. Mirror its authoritative constants or the voice/SMS
//     context bundle finds zero skills.
//   * SOUL.md / MEMORY.md are vault-canonical top-level files → vault root.
// The old `/mnt/encrypted/openclaw/workspace` host path does not exist here,
// which is what made the voice agent "not know who Sir is" at call start.
const HERMES_HOME = process.env.HERMES_HOME ?? "/opt/data";
const HERMES_PROFILES_DIR =
  process.env.HERMES_CONFIG_DIR ?? `${HERMES_HOME}/profiles`;
const SKILLS_DIR = `${HERMES_PROFILES_DIR}/main/workspace/skills`;

// Exported for the path-resolution regression test (see
// tests/skills-soul-memory-paths.test.ts).
export const RESOLVED_SKILLS_DIR = SKILLS_DIR;
export const RESOLVED_VAULT_PATH = VAULT_PATH;
export const RESOLVED_MEMORY_PATH = `${VAULT_PATH}/MEMORY.md`;
export const RESOLVED_SOUL_PATH = `${VAULT_PATH}/SOUL.md`;
export const RESOLVED_VOICE_SKILL_PATH = `${SKILLS_DIR}/alfred-voice/SKILL.md`;
const OPENCLAW_GATEWAY_URL =
  process.env.OPENCLAW_GATEWAY_URL ?? "http://openclaw:18789";
// Gateway token lookup paths. ctrl-api mounts the same file as
// openclaw + alfred-learn but at a different path (/mnt/encrypted/alfred/
// rather than /alfred-data/). The env var set by docker-compose is the
// authoritative source; the two fallbacks cover dev + legacy deployments.
// Previously this was hardcoded to /alfred-data/.gateway-token which
// never existed inside ctrl-api → every phone/sms call 502'd with
// "Gateway token not available".
const GATEWAY_TOKEN_CANDIDATES = [
  process.env.OPENCLAW_GATEWAY_TOKEN_FILE,
  "/mnt/encrypted/alfred/.gateway-token",
  "/alfred-data/.gateway-token",
].filter((p): p is string => typeof p === "string" && p.length > 0);
const ALFRED_DATA_DIR = process.env.ALFRED_DATA_DIR ?? "/alfred-data";
const AUTHORIZED_NUMBERS_FILE = `${ALFRED_DATA_DIR}/.authorized-phone-numbers.json`;
const SMS_THREAD_PREFIX = "sms-phone-";

// SaaS internal callback (used to ship outbound SMS replies through Twilio)
const SAAS_INTERNAL_URL =
  process.env.SAAS_INTERNAL_URL ?? "https://alfred.black";
const VOICE_BRIDGE_INTERNAL_TOKEN =
  process.env.VOICE_BRIDGE_INTERNAL_TOKEN ?? "";

// 60 s in-memory cache of the voice context bundle. Voice calls fetch this on
// connect and we don't want to re-walk the vault per call.
let voiceContextCache: { at: number; bundle: VoiceContextBundle } | null = null;
const VOICE_CONTEXT_TTL_MS = 60_000;

interface VoiceContextBundle {
  memoryMd: string;
  voiceSkill: string;
  openMatters: Array<{ name: string; summary?: string }>;
  openTasks: Array<{ name: string; due?: string; summary?: string }>;
  recentSessions: Array<{ at: string; channel: string; summary: string }>;
  composioToolkits: Array<{
    toolkit: string;
    actions: Array<{ name: string; description: string }>;
  }>;
  generatedAt: string;
}

function readComposioToolkits(): Array<{
  toolkit: string;
  actions: Array<{ name: string; description: string }>;
}> {
  const skillsDir = SKILLS_DIR;
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(skillsDir)
      .filter((d: string) => d.startsWith("alfred-composio-"));
  } catch {
    return [];
  }
  const out: Array<{
    toolkit: string;
    actions: Array<{ name: string; description: string }>;
  }> = [];
  for (const d of dirs) {
    const toolkit = d.replace(/^alfred-composio-/, "");
    const skillPath = `${skillsDir}/${d}/SKILL.md`;
    let body: string;
    try {
      body = fs.readFileSync(skillPath, "utf-8");
    } catch {
      continue;
    }
    // Extract rows of the "## Actions" markdown table.
    //   | `ACTION_NAME` | type | description |
    const actions: Array<{ name: string; description: string }> = [];
    const tableMatch = body.match(/##\s*Actions[\s\S]+?(?=\n##|\n?$)/);
    const tableSrc = tableMatch ? tableMatch[0] : "";
    const rowRe = /\|\s*`([A-Z][A-Z0-9_]+)`\s*\|[^|]*\|\s*([^|\n]+?)\s*\|/g;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(tableSrc)) !== null) {
      actions.push({
        name: m[1],
        description: m[2].slice(0, 120).trim(),
      });
    }
    if (actions.length > 0) out.push({ toolkit, actions });
  }
  return out;
}

function readFileSafe(path: string, max = 16_000): string {
  try {
    const text = fs.readFileSync(path, "utf-8");
    return text.length > max ? text.slice(0, max) : text;
  } catch {
    return "";
  }
}

function readJsonlTail(
  path: string,
  maxLines: number,
): Array<Record<string, unknown>> {
  try {
    const text = fs.readFileSync(path, "utf-8");
    const lines = text
      .split("\n")
      .filter((l: string) => l.trim().length > 0);
    return lines.slice(-maxLines).map((l: string) => JSON.parse(l));
  } catch {
    return [];
  }
}

function listVaultRecords(
  type: string,
  status?: string,
): Array<{ name: string; summary?: string; due?: string }> {
  const dir = `${VAULT_PATH}/${type}`;
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Array<{ name: string; summary?: string; due?: string }> = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(`${dir}/${f}`, "utf-8");
      const fm = parseFrontmatter(raw);
      if (status && fm.status && fm.status !== status) continue;
      out.push({
        name: typeof fm.name === "string" ? fm.name : f.replace(/\.md$/, ""),
        summary: typeof fm.summary === "string" ? fm.summary : undefined,
        due: typeof fm.due === "string" ? fm.due : undefined,
      });
    } catch {
      // ignore malformed
    }
  }
  return out.slice(0, 20);
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return {};
  const body = raw.slice(3, end).trim();
  const out: Record<string, unknown> = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v: any = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v === "true") v = true;
    else if (v === "false") v = false;
    out[m[1]] = v;
  }
  return out;
}

function buildVoiceContext(): VoiceContextBundle {
  const memoryMd = readFileSafe(`${VAULT_PATH}/MEMORY.md`, 8_000);
  const voiceSkill = readFileSafe(
    `${SKILLS_DIR}/alfred-voice/SKILL.md`,
    8_000,
  );
  const openMatters = listVaultRecords("matter", "active");
  const openTasks = listVaultRecords("task", "active");

  // Recent main-agent sessions: tail the system-openclaw-sessions stream.
  const sessionEvents = readJsonlTail(
    `${STREAMS_DIR}/system-openclaw-sessions.jsonl`,
    20,
  );
  const recentSessions = sessionEvents.map((e) => ({
    at: typeof e.received_at === "string" ? e.received_at : "",
    channel:
      typeof e.metadata === "object" && e.metadata
        ? String((e.metadata as any).channel ?? "openclaw")
        : "openclaw",
    summary: typeof e.summary === "string" ? e.summary : "",
  }));

  return {
    memoryMd,
    voiceSkill,
    openMatters,
    openTasks,
    recentSessions,
    composioToolkits: readComposioToolkits(),
    generatedAt: new Date().toISOString(),
  };
}

function getVoiceContextCached(): VoiceContextBundle {
  const now = Date.now();
  if (voiceContextCache && now - voiceContextCache.at < VOICE_CONTEXT_TTL_MS) {
    return voiceContextCache.bundle;
  }
  const bundle = buildVoiceContext();
  voiceContextCache = { at: now, bundle };
  return bundle;
}

function getGatewayToken(): string {
  for (const candidate of GATEWAY_TOKEN_CANDIDATES) {
    try {
      const v = fs.readFileSync(candidate, "utf-8").trim();
      if (v) return v;
    } catch {
      /* try next candidate */
    }
  }
  return "";
}

async function notifyMainSession(message: string): Promise<void> {
  const token = getGatewayToken();
  if (!token) return;
  try {
    await fetch(`${OPENCLAW_GATEWAY_URL}/v1/sessions/message`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: "alfred-main",
        message,
        metadata: { source: "agentphone", type: "voice-call-summary" },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.warn("[phone] notifyMainSession failed", err);
  }
}

async function ingestStreamEvent(event: Record<string, unknown>): Promise<void> {
  // Same effect as posting to /api/v1/streams/ingest, but inline so we don't
  // pay the localhost auth round-trip. ctrl-api server is the only writer for
  // this directory in normal operation.
  const safe = String(event["stream_id"] ?? "voice-call").replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const path = `${STREAMS_DIR}/${safe}.jsonl`;
  fs.mkdirSync(STREAMS_DIR, { recursive: true });
  fs.appendFileSync(path, JSON.stringify(event) + "\n", "utf-8");
}

// ── Authorised-numbers list ─────────────────────────────────────────────────

function normaliseNumber(n: string): string {
  return n.trim().replace(/[\s\-()]/g, "");
}

function readAuthorizedNumbers(): string[] {
  try {
    const raw = fs.readFileSync(AUTHORIZED_NUMBERS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n) => typeof n === "string");
  } catch {
    return [];
  }
}

function writeAuthorizedNumbers(numbers: string[]): void {
  fs.mkdirSync(ALFRED_DATA_DIR, { recursive: true });
  // Dedup + normalise.
  const uniq = Array.from(new Set(numbers.map(normaliseNumber))).filter(
    (n) => n.length > 0,
  );
  fs.writeFileSync(
    AUTHORIZED_NUMBERS_FILE,
    JSON.stringify(uniq, null, 2),
    "utf-8",
  );
}

// ── Per-sender SMS thread context ────────────────────────────────────────────

interface SmsTurn {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

function smsThreadPath(from: string): string {
  const safe = normaliseNumber(from).replace(/[^a-zA-Z0-9_+]/g, "_");
  return `${STREAMS_DIR}/${SMS_THREAD_PREFIX}${safe}.jsonl`;
}

function readSmsThread(from: string, maxTurns = 20): SmsTurn[] {
  try {
    const text = fs.readFileSync(smsThreadPath(from), "utf-8");
    const lines = text.split("\n").filter((l: string) => l.trim().length > 0);
    return lines
      .slice(-maxTurns)
      .map((l: string) => JSON.parse(l) as SmsTurn);
  } catch {
    return [];
  }
}

function appendSmsTurn(from: string, turn: SmsTurn): void {
  fs.mkdirSync(STREAMS_DIR, { recursive: true });
  fs.appendFileSync(smsThreadPath(from), JSON.stringify(turn) + "\n", "utf-8");
}

// ── openclaw chat completions wrapper (synchronous reply path) ───────────────

function readMainAgentModel(): string {
  // Openclaw's /v1/chat/completions endpoint routes via agent identity —
  // it expects "openclaw" (picks agent defaults) or "openclaw/<agentId>"
  // (specific agent), NOT the upstream model slug like "xai/grok-4" or
  // "openrouter/...". If we pass the upstream slug directly, openclaw
  // returns 400 "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`".
  //
  // SMS replies should go through the main agent's persona + tools, so
  // route via "openclaw/main".
  return "openclaw/main";
}

function buildSmsSystemPrompt(): string {
  const memoryMd = readFileSafe(`${VAULT_PATH}/MEMORY.md`, 6_000);
  // No voice persona — SMS is text. Use SOUL.md if present plus a tight
  // SMS overlay; fall back to the platform persona text.
  const soul = readFileSafe(`${VAULT_PATH}/SOUL.md`, 6_000);

  const overlay = [
    "You are Alfred, replying to Sir over SMS.",
    "Maximum two short sentences per reply. No markdown, no asterisks, no lists.",
    "Speak names, not IDs. Numbers in full digits are fine for SMS (unlike voice).",
    "If asked to do something, use the `self` MCP tool — wait, you don't have tools here.",
    "If you need data you don't have, ask Sir one short clarifying question.",
    'Goodbye: "Right, sir." Nothing more.',
  ].join("\n");

  // Fold the cross-channel context bundle into the system prompt so SMS
  // shares context with voice + Slack.
  const ctx = getVoiceContextCached();
  const primer: string[] = [];
  if (ctx.openMatters?.length) {
    primer.push(
      "## Open matters\n" +
        ctx.openMatters
          .slice(0, 6)
          .map((m) => `- ${m.name}`)
          .join("\n"),
    );
  }
  if (ctx.openTasks?.length) {
    primer.push(
      "## Open tasks\n" +
        ctx.openTasks
          .slice(0, 6)
          .map((t) => `- ${t.name}${t.due ? ` (due ${t.due})` : ""}`)
          .join("\n"),
    );
  }
  if (ctx.recentSessions?.length) {
    primer.push(
      "## Recent conversations\n" +
        ctx.recentSessions
          .slice(-6)
          .map((s) => `- [${s.at.slice(0, 16)}] ${s.summary}`)
          .join("\n"),
    );
  }

  const parts = [soul.trim(), overlay, memoryMd.trim(), primer.join("\n\n")]
    .filter((p) => p && p.length > 0)
    .join("\n\n");
  return parts;
}

interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  temperature?: number;
}

async function openclawChatCompletion(
  req: ChatCompletionRequest,
): Promise<string> {
  const token = getGatewayToken();
  if (!token) throw new Error("Gateway token not available");
  const res = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(req),
    // Main agent session bootstrap (workspace skills + TOOLS.md + MEMORY
    // + tool allowlist) can take ~15-30s cold, plus the actual LLM call.
    // 25s was blowing up on the first SMS each session. 120s covers a
    // cold boot + a thinking reply; Twilio's webhook timeout is 15s but
    // the SaaS already returned 200 to Twilio before calling here, so
    // the long wait only affects how long before the user sees a reply
    // on their phone — not Twilio delivery.
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(
      `chat completions failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const data: any = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("chat completions returned no message content");
  }
  return text.trim();
}

// ── Outbound SMS shipping (via SaaS) ─────────────────────────────────────────

interface InstanceMeta {
  tenantId: string;
  phoneNumber: string;
}

function readInstanceMeta(): InstanceMeta | null {
  // Tenant id + phone number live in the .env file the provisioner wrote.
  // Cheap parse; ctrl-api already sees these env vars but we want freshness.
  const tenantId = process.env.TENANT_ID ?? "";
  const phoneNumber =
    process.env.AGENTPHONE_PHONE_NUMBER ??
    process.env.TWILIO_PHONE_NUMBER ??
    "";
  if (!tenantId || !phoneNumber) return null;
  return { tenantId, phoneNumber };
}

async function shipSmsViaSaas(opts: {
  to: string;
  body: string;
}): Promise<{ ok: boolean; error?: string; sid?: string }> {
  const meta = readInstanceMeta();
  if (!meta) return { ok: false, error: "TENANT_ID or phone number not set" };
  if (!VOICE_BRIDGE_INTERNAL_TOKEN) {
    return { ok: false, error: "VOICE_BRIDGE_INTERNAL_TOKEN not set" };
  }
  try {
    const res = await fetch(`${SAAS_INTERNAL_URL}/api/internal/twilio/send-sms`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VOICE_BRIDGE_INTERNAL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tenantId: meta.tenantId,
        from: meta.phoneNumber,
        to: opts.to,
        body: opts.body,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `SaaS send-sms ${res.status}: ${await res.text().catch(() => "")}`,
      };
    }
    const body: any = await res.json().catch(() => ({}));
    return { ok: true, sid: body?.sid };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ── Cross-channel-memory audit echo ──────────────────────────────────────────

async function auditEchoSmsTurn(
  from: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const token = getGatewayToken();
  if (!token) return;
  const message = `[SMS from ${from}]\n> ${userText.slice(0, 400)}\n\nReply: ${assistantText.slice(0, 400)}`;
  try {
    await fetch(`${OPENCLAW_GATEWAY_URL}/v1/sessions/message`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: "alfred-main",
        message,
        metadata: { source: "agentphone", channel: "sms", from },
      }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // best-effort
  }
}

export function registerPhoneRoutes(): void {
  // GET /api/v1/phone/voice-context — bundle for the bridge to inline
  addRoute("GET", "/api/v1/phone/voice-context", async ({ res }) => {
    sendJson(res, 200, getVoiceContextCached());
  });

  // GET /api/v1/phone/config — single endpoint for the dashboard PhonePage.
  // Returns: tenant phone number, authorized list, last N call/SMS records.
  addRoute("GET", "/api/v1/phone/config", async ({ res }) => {
    const meta = readInstanceMeta();
    const phoneNumber = meta?.phoneNumber ?? null;

    // Recent activity: tail the relevant streams. We sample multiple sources
    // because inbound vs outbound + SMS vs voice all live in different files.
    const sources = [
      "voice-call",
      "voice-call-outbound",
      "sms-inbound",
      "sms-outbound",
    ];
    const events: Array<{
      kind: "voice" | "sms";
      direction: "inbound" | "outbound";
      from?: string;
      to?: string;
      summary: string;
      at: string;
    }> = [];
    for (const source of sources) {
      const lines = readJsonlTail(`${STREAMS_DIR}/${source}.jsonl`, 30);
      for (const e of lines) {
        const raw = (e.raw ?? {}) as Record<string, unknown>;
        const kind = source.startsWith("voice") ? "voice" : "sms";
        const direction = source.endsWith("outbound") ? "outbound" : "inbound";
        events.push({
          kind,
          direction,
          from: typeof raw.from === "string" ? raw.from : undefined,
          to: typeof raw.to === "string" ? raw.to : undefined,
          summary: typeof e.summary === "string" ? e.summary : "",
          at:
            typeof e.received_at === "string"
              ? e.received_at
              : new Date().toISOString(),
        });
      }
    }
    events.sort((a, b) => (a.at < b.at ? 1 : -1));

    sendJson(res, 200, {
      phoneNumber,
      authorizedNumbers: readAuthorizedNumbers(),
      recentActivity: events.slice(0, 30),
    });
  });

  // ── Authorised-numbers CRUD ───────────────────────────────────────────────
  addRoute("GET", "/api/v1/phone/authorized-numbers", async ({ res }) => {
    sendJson(res, 200, { numbers: readAuthorizedNumbers() });
  });

  addRoute("PUT", "/api/v1/phone/authorized-numbers", async ({ res, body }) => {
    const b = body as { numbers?: unknown } | undefined;
    if (!b || !Array.isArray(b.numbers)) {
      throw new ValidationError("body.numbers (string[]) required");
    }
    writeAuthorizedNumbers(b.numbers as string[]);
    sendJson(res, 200, { numbers: readAuthorizedNumbers() });
  });

  addRoute("POST", "/api/v1/phone/authorized-numbers", async ({ res, body }) => {
    const b = body as { number?: unknown } | undefined;
    if (!b || typeof b.number !== "string") {
      throw new ValidationError("body.number (string) required");
    }
    const current = readAuthorizedNumbers();
    writeAuthorizedNumbers([...current, b.number as string]);
    sendJson(res, 201, { numbers: readAuthorizedNumbers() });
  });

  addRoute(
    "DELETE",
    "/api/v1/phone/authorized-numbers/:number",
    async ({ res, params }) => {
      const target = normaliseNumber(decodeURIComponent(params["number"]));
      const current = readAuthorizedNumbers();
      const next = current.filter((n) => normaliseNumber(n) !== target);
      if (next.length === 0 && current.length > 0) {
        sendJson(res, 400, {
          error:
            "Cannot delete the last authorized number — add another first",
        });
        return;
      }
      writeAuthorizedNumbers(next);
      sendJson(res, 200, { numbers: readAuthorizedNumbers() });
    },
  );

  // ── Inbound SMS routing (called by SaaS twilio/sms webhook) ──────────────
  addRoute("POST", "/api/v1/phone/sms/inbound", async ({ res, body }) => {
    const b = body as
      | { from?: string; to?: string; body?: string; messageSid?: string }
      | undefined;
    if (!b || typeof b.from !== "string" || typeof b.to !== "string") {
      throw new ValidationError("from, to required");
    }
    const from = b.from;
    const to = b.to;
    const text = (b.body ?? "").trim();
    const messageSid = b.messageSid ?? `${from}-${Date.now()}`;

    const authorized = readAuthorizedNumbers().map(normaliseNumber);
    const normalisedFrom = normaliseNumber(from);
    let isAuthorized = authorized.includes(normalisedFrom);

    // Bootstrap-trust: if the authorized list is empty, treat the first
    // inbound SMS as the tenant owner's number and auto-add it. The
    // assumption holds because the tenant's Twilio number is freshly
    // provisioned and known only to the owner (given via dashboard).
    // Also prevents the ugly UX where a brand-new tenant has to hand-
    // configure trust before their first SMS ever gets a reply.
    //
    // SaaS-side already filters spam numbers before proxying here, so the
    // auto-trust window is bounded to real human senders.
    if (!isAuthorized && authorized.length === 0) {
      writeAuthorizedNumbers([normalisedFrom]);
      console.log(
        "[phone/sms] bootstrap-trusted first sender %s (empty authorized list)",
        normalisedFrom,
      );
      isAuthorized = true;
    }

    if (!isAuthorized) {
      // Stream pipeline. Bridge to the zero-LLM template path so hourly
      // enrichment can later turn this into vault context.
      const event = {
        id: cryptoRandomId(),
        stream_id: "sms-inbound",
        stream_type: "sms",
        received_at: new Date().toISOString(),
        source_ref: messageSid,
        raw: { from, to, body: text, direction: "inbound" },
        summary: `SMS from ${from}: ${text.slice(0, 80)}`,
      };
      await ingestStreamEvent(event);
      sendJson(res, 200, { status: "stream-ingested", event_id: event.id });
      return;
    }

    // Authorised → openclaw chat completion → ship reply via Twilio.
    const ts = new Date().toISOString();
    const userTurn: SmsTurn = { role: "user", content: text, ts };
    const priorTurns = readSmsThread(from, 20);
    appendSmsTurn(from, userTurn);

    let reply = "";
    try {
      reply = await openclawChatCompletion({
        model: readMainAgentModel(),
        messages: [
          { role: "system", content: buildSmsSystemPrompt() },
          ...priorTurns.map((t) => ({ role: t.role, content: t.content })),
          { role: "user", content: text },
        ],
        stream: false,
      });
    } catch (err: any) {
      console.error("[phone/sms] chat completion failed", err);
      // Even on failure, persist a placeholder so we don't lose the user turn.
      sendJson(res, 502, { status: "completion-failed", error: err?.message });
      return;
    }

    appendSmsTurn(from, {
      role: "assistant",
      content: reply,
      ts: new Date().toISOString(),
    });

    const ship = await shipSmsViaSaas({ to: from, body: reply });
    void auditEchoSmsTurn(from, text, reply);

    if (!ship.ok) {
      console.error("[phone/sms] ship failed", ship.error);
      sendJson(res, 502, { status: "ship-failed", error: ship.error, reply });
      return;
    }
    sendJson(res, 200, { status: "replied", reply, sid: ship.sid });
  });

  // ── Outbound SMS (agent-initiated) ───────────────────────────────────────
  addRoute("POST", "/api/v1/phone/sms", async ({ res, body }) => {
    const b = body as { to?: unknown; body?: unknown } | undefined;
    if (!b || typeof b.to !== "string" || typeof b.body !== "string") {
      throw new ValidationError("to (string), body (string) required");
    }
    const to = b.to.trim();
    const text = b.body.trim();
    if (!to || !text) {
      throw new ValidationError("to and body must be non-empty");
    }

    const ship = await shipSmsViaSaas({ to, body: text });
    if (!ship.ok) {
      sendJson(res, 502, { status: "ship-failed", error: ship.error });
      return;
    }

    // Log outbound to the streams pipeline for vault visibility + dashboard.
    const meta = readInstanceMeta();
    const event = {
      id: cryptoRandomId(),
      stream_id: "sms-outbound",
      stream_type: "sms",
      received_at: new Date().toISOString(),
      source_ref: ship.sid ?? cryptoRandomId(),
      raw: {
        from: meta?.phoneNumber ?? "",
        to,
        body: text,
        direction: "outbound",
      },
      summary: `SMS to ${to}: ${text.slice(0, 80)}`,
    };
    await ingestStreamEvent(event);

    sendJson(res, 200, { status: "sent", sid: ship.sid });
  });

  // ── Outbound call (agent-initiated) ──────────────────────────────────────
  // mode: "tts"      — one-shot TTS playback via SaaS /api/twiml/say
  // mode: "realtime" — opens a live Voice Bridge session with initiator=alfred
  addRoute("POST", "/api/v1/phone/call", async ({ res, body }) => {
    const b = body as
      | { to?: unknown; message?: unknown; mode?: unknown }
      | undefined;
    if (!b || typeof b.to !== "string" || typeof b.message !== "string") {
      throw new ValidationError("to (string), message (string) required");
    }
    const mode = b.mode === "realtime" ? "realtime" : "tts";
    const to = b.to.trim();
    const message = b.message.trim();
    if (!to || !message) {
      throw new ValidationError("to and message must be non-empty");
    }

    const meta = readInstanceMeta();
    if (!meta) {
      sendJson(res, 409, {
        status: "no-tenant-meta",
        error: "TENANT_ID or phone number not set",
      });
      return;
    }
    if (!VOICE_BRIDGE_INTERNAL_TOKEN) {
      sendJson(res, 500, {
        status: "misconfigured",
        error: "VOICE_BRIDGE_INTERNAL_TOKEN not set",
      });
      return;
    }

    let sid: string | undefined;
    try {
      const res2 = await fetch(
        `${SAAS_INTERNAL_URL}/api/internal/twilio/initiate-call`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${VOICE_BRIDGE_INTERNAL_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            tenantId: meta.tenantId,
            to,
            mode,
            message,
          }),
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!res2.ok) {
        sendJson(res, 502, {
          status: "saas-call-failed",
          error: `${res2.status}: ${await res2.text().catch(() => "")}`,
        });
        return;
      }
      const out: any = await res2.json().catch(() => ({}));
      sid = out?.sid;
    } catch (err: any) {
      sendJson(res, 502, {
        status: "saas-unreachable",
        error: err?.message ?? String(err),
      });
      return;
    }

    // Log outbound call kickoff (the real transcript lands later via
    // POST /api/v1/phone/transcript when the bridge ends the call, in
    // the realtime mode case).
    const event = {
      id: cryptoRandomId(),
      stream_id: "voice-call-outbound",
      stream_type: "voice-call",
      received_at: new Date().toISOString(),
      source_ref: sid ?? cryptoRandomId(),
      raw: {
        from: meta.phoneNumber,
        to,
        direction: "outbound",
        mode,
        intent: message,
        callId: sid ?? "",
      },
      summary: `${mode === "realtime" ? "Live call" : "TTS call"} to ${to}: ${message.slice(0, 80)}`,
    };
    await ingestStreamEvent(event);

    sendJson(res, 200, { status: "initiated", sid, mode });
  });

  // POST /api/v1/phone/transcript — bridge posts the full call transcript
  addRoute("POST", "/api/v1/phone/transcript", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b) throw new ValidationError("body required");
    const from = typeof b.from === "string" ? b.from : "";
    const to = typeof b.to === "string" ? b.to : "";
    const callId = typeof b.callId === "string" ? b.callId : "";
    const startedAt =
      typeof b.started_at === "string"
        ? b.started_at
        : new Date().toISOString();
    const endedAt =
      typeof b.ended_at === "string" ? b.ended_at : new Date().toISOString();
    const transcript = Array.isArray(b.transcript) ? b.transcript : [];
    const summary =
      typeof b.summary === "string" && b.summary.trim().length > 0
        ? b.summary
        : `Call from ${from || "unknown"}`;

    const event = {
      id: cryptoRandomId(),
      stream_id: "voice-call",
      stream_type: "voice-call",
      received_at: endedAt,
      source_ref: callId || `${from}-${endedAt}`,
      raw: {
        from,
        to,
        started_at: startedAt,
        ended_at: endedAt,
        duration_seconds: durationSeconds(startedAt, endedAt),
        transcript,
        callId,
      },
      summary,
    };

    await ingestStreamEvent(event);
    // Best-effort cross-channel-memory ping. Failure does not block.
    void notifyMainSession(`Phone call ended: ${summary}`);
    sendJson(res, 201, { status: "ingested", event_id: event.id });
  });
}

function cryptoRandomId(): string {
  // Cheap, no crypto import needed; ctrl-api is single-process.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function durationSeconds(start: string, end: string): number {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return 0;
  return Math.max(0, Math.round((e - s) / 1000));
}
