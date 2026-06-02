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
import { dockerComposeCmd } from "../helpers.js";
import { patchEnv } from "./credentials.js";
import { getStateDb } from "../../db/state.js";
import {
  appendJournal,
  bindPrincipalChannel,
  queryRecentJournal,
} from "../../db/alfredJournal.js";

// Defaults match the merged single-VM stack's ctrl-api mounts: vault at
// /vault (vault_data volume) and alfred-data at /alfred-data (alfred_data
// volume). Env-var overrides are honoured. Skills + SOUL/MEMORY are resolved
// separately below — see the split comment on SKILLS_DIR.
const VAULT_PATH = process.env.VAULT_PATH ?? "/vault";
const STREAMS_DIR = `${process.env.ALFRED_DATA_DIR ?? "/alfred-data"}/streams`;

// Skills vs SOUL/MEMORY split (merged single-VM stack — no openclaw mount):
//   * SKILLS (alfred-composio-*, alfred-voice, and the rest of the platform
//     skill suite) live at the Hermes-canonical per-profile location:
//     `<HERMES_HOME>/profiles/<profile>/skills`. The hermes-init container
//     deploys platform skills here and Hermes reads from here. ctrl-api's
//     Composio skill generator must write to the same dir or the voice/SMS
//     primer + Hermes runtime read different directories. (For ~2 months
//     ctrl-api wrote to a parallel `workspace/skills/` dir that Hermes
//     never read — see entrypoint.sh's one-time consolidation step.)
//   * SOUL.md / MEMORY.md are vault-canonical top-level files → vault root.
// The old `/mnt/encrypted/openclaw/workspace` host path does not exist here,
// which is what made the voice agent "not know who Sir is" at call start.
const HERMES_HOME = process.env.HERMES_HOME ?? "/opt/data";
const HERMES_PROFILES_DIR =
  process.env.HERMES_CONFIG_DIR ?? `${HERMES_HOME}/profiles`;
const SKILLS_DIR = `${HERMES_PROFILES_DIR}/main/skills`;

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
  /** IANA timezone name sourced from the principal's primary Google Calendar
   *  (cached in composio_user_defaults). Fallback: "UTC". Lane V voice-bridge
   *  reads this to compute a per-call current-time anchor — it never reuses a
   *  stale timestamp from the cached bundle (see issue #226). */
  timeZone: string;
  /** Per-MCP-server skill cheatsheets. Replaces the v1 `composioToolkits`
   *  action-by-action dump: voice-bridge has 150 prefixed MCP tools
   *  (`alfred__*`, `sure__*`, `plane__*`, `vaultwarden__*`, `execute__*`)
   *  already declared in `session.update tools` — the OpenAI Realtime
   *  model reads tool schemas natively, so the prompt only needs to teach
   *  WHEN to reach for each server, not WHAT each tool does. One entry
   *  per server-aligned skill: alfred-vault-operations (alfred),
   *  alfred-sure-operations (sure), alfred-plane-operations (plane),
   *  alfred-connected-apps (execute / composio). vaultwarden has no
   *  dedicated skill — its 14 tool schemas are self-describing.
   *  `body` carries the SKILL.md description + H1 intro (~600 chars
   *  each) — enough to anchor server selection, small enough not to
   *  saturate attention and let memory-md Hungarian content code-switch
   *  the agent (the symptom that triggered this redesign). */
  skills: Array<{ name: string; description: string; body: string }>;
  generatedAt: string;
}

// The 4 ops skills the voice agent gets a cheatsheet for. Each maps to one of
// the 5 MCP servers voice-bridge connects to (see voice-bridge/src/mcp-clients.ts).
// vaultwarden has no entry — its 14 tool schemas are self-describing and the
// agent reaches for them via the `vaultwarden__*` prefix without needing prose.
const VOICE_OPS_SKILLS = [
  "alfred-vault-operations",   // alfred MCP — vault read/write
  "alfred-sure-operations",    // sure MCP — personal finance
  "alfred-plane-operations",   // plane MCP — work / projects
  "alfred-connected-apps",     // execute MCP — composio third-party apps
] as const;

/** Read SKILL.md, return `{description, body}` where description is the
 *  frontmatter `description:` value and body is the H1 + first paragraph
 *  (everything from `# ` to the first `## ` heading, capped at `maxBody`
 *  chars). Returns null when the file isn't there or has no frontmatter
 *  description — those skills just get omitted from the bundle instead
 *  of carrying a junk record.
 *
 *  Why H1+first-paragraph rather than the whole skill body: alfred-sure-
 *  operations is 1095 lines / 73 KB — injecting that wholesale into every
 *  voice session prompt drowns the persona and inflates token cost. The
 *  H1+intro tells the model when to reach for the server; the tool schemas
 *  on the OpenAI side carry the per-action details. */
function readSkillSummary(
  name: string,
  maxBody = 800,
): { description: string; body: string } | null {
  const skillPath = `${SKILLS_DIR}/${name}/SKILL.md`;
  let raw: string;
  try {
    raw = fs.readFileSync(skillPath, "utf-8");
  } catch {
    return null;
  }
  // Pull `description:` out of the YAML frontmatter (line-anchored, single-line).
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  let description = "";
  let bodyStart = 0;
  if (fmMatch) {
    const fm = fmMatch[1];
    const descLine = fm.match(/^description:\s*(.+)$/m);
    if (descLine) {
      description = descLine[1].trim().replace(/^["']|["']$/g, "");
    }
    bodyStart = fmMatch[0].length;
  }
  if (!description) return null;
  // Body = from the H1 to the first H2; clipped to maxBody.
  const tail = raw.slice(bodyStart);
  const h1Idx = tail.search(/^#\s+/m);
  const startsAt = h1Idx >= 0 ? h1Idx : 0;
  const tailFromH1 = tail.slice(startsAt);
  const h2Match = tailFromH1.match(/\n##\s+/);
  const end = h2Match && typeof h2Match.index === "number"
    ? h2Match.index
    : tailFromH1.length;
  const body = tailFromH1.slice(0, end).trim().slice(0, maxBody);
  return { description, body };
}

/** Strip the "Last user: …" suffix that alfred_journal records on voice
 *  session summaries. Leaving it in echoes whatever language Sir last
 *  spoke (Hungarian, Spanish, …) back into the next session prompt —
 *  which, against a one-paragraph English persona competing with a
 *  five-KB MEMORY.md, was the proximate cause of the gpt-realtime-2
 *  code-switching regression on 2026-05-26. The agent doesn't need the
 *  quote — the freshness signal is the whole point of the section. */
function sanitizeSessionSummary(summary: string): string {
  return summary.replace(/\s*Last user:[\s\S]*$/i, "").trim();
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

/** Read the principal's primary-calendar IANA timezone from the
 *  composio_user_defaults cache (toolkit=googlecalendar, newest row).
 *  Returns "UTC" on any miss, malformed JSON, or unexpected error. */
function readCalendarTimeZone(): string {
  try {
    const db = getStateDb();
    const row = db
      .prepare(
        `SELECT default_args_json
           FROM composio_user_defaults
          WHERE toolkit = 'googlecalendar'
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get() as { default_args_json: string } | undefined;
    if (!row) return "UTC";
    let parsed: unknown;
    try { parsed = JSON.parse(row.default_args_json); } catch { return "UTC"; }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).timeZone === "string" &&
      (parsed as Record<string, unknown>).timeZone
    ) {
      return (parsed as Record<string, unknown>).timeZone as string;
    }
    return "UTC";
  } catch {
    return "UTC";
  }
}

function buildVoiceContext(): VoiceContextBundle {
  // MEMORY.md is shared with the text agents, where the full corpus matters.
  // For voice we truncate hard — the field is mostly principal-biography in
  // mixed Hungarian/English; injecting all 5–8 KB of it competes with the
  // English persona and was a contributing factor to the 2026-05-26 code-
  // switching regression. 1200 chars keeps the top-of-file most-critical
  // names without the long company-by-company tail. (Text agents still
  // load the full MEMORY.md via their own loader path.)
  const memoryMd = readFileSafe(`${VAULT_PATH}/MEMORY.md`, 1_200);
  const voiceSkill = readFileSafe(
    `${SKILLS_DIR}/alfred-voice/SKILL.md`,
    10_000,
  );
  const openMatters = listVaultRecords("matter", "active");
  const openTasks = listVaultRecords("task", "active");

  // Recent main-agent sessions across channels: pulled from alfred_journal,
  // scoped to the owner principal (Telegram + Slack + SMS + voice all bind to
  // 'owner' on first contact). The summary is sanitized — we drop the
  // "Last user: …" quote so non-English last-utterances don't echo back as
  // bilingual primer signal (see sanitizeSessionSummary above).
  const recentSessions = safeRecentJournal();

  // Per-server skill cheatsheets for the 4 MCP servers that have one. Each
  // gets the SKILL.md description + H1 intro paragraph (≈600 chars), not
  // the full body — the agent uses the tool schemas declared via
  // session.update tools for per-action detail.
  const skills: Array<{ name: string; description: string; body: string }> = [];
  for (const name of VOICE_OPS_SKILLS) {
    const s = readSkillSummary(name);
    if (s) skills.push({ name, ...s });
  }

  // IANA timezone from the principal's primary Google Calendar defaults cache
  // (#226). Fallback "UTC" on any miss or parse error — voice-bridge computes
  // the current-time anchor per call using this string; we never bake a
  // timestamp here (bundle is cached 60s).
  const timeZone = readCalendarTimeZone();

  return {
    memoryMd,
    voiceSkill,
    openMatters,
    openTasks,
    recentSessions,
    timeZone,
    skills,
    generatedAt: new Date().toISOString(),
  };
}

function safeRecentJournal(): Array<{
  at: string;
  channel: string;
  summary: string;
}> {
  // Defensive: never let a transient DB hiccup break voice-context. The
  // bundle is best-effort by design (the bridge tolerates null); a missing
  // recent-sessions section just means the voice agent runs on its
  // baseline context.
  try {
    const db = getStateDb();
    const entries = queryRecentJournal(
      db,
      { principal_id: "owner" },
      { limit: 20, within_hours: 168 }, // last 7 days
    );
    return entries.map((e) => {
      // Strip the "Last user: …" suffix before truncating — leaving it in
      // would echo Sir's last utterance verbatim into the next session
      // prompt (Hungarian/Spanish/etc.), which against an English persona
      // is a strong code-switching signal. Sanitize first, then truncate
      // to 200 chars so the freshness summary stays compact.
      const cleaned = sanitizeSessionSummary(e.message);
      return {
        at: e.ts,
        channel: e.channel,
        summary: cleaned.length > 200 ? cleaned.slice(0, 200) + "…" : cleaned,
      };
    });
  } catch (err) {
    console.warn(
      "[voice-context] recent-journal query failed (non-blocking):",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
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

  // POST /api/v1/phone/provision — Contract C15.
  // Body: { openai_api_key, twilio_account_sid, twilio_auth_token,
  //         phone_number? | buy:{country, area_code?} }
  //   → 200 { phone_number, provisioned } / 4xx { error, code }
  //
  // Persists the creds (the now-allowlisted KNOWN_CREDENTIALS keys) into the
  // compose .env (bind-mounted RW per F40) and (re)starts the voice-bridge
  // service so it picks up the new OPENAI_API_KEY + token. The actual Twilio
  // number purchase (F70/F71) is a separate Lane V task; here only BYO
  // `phone_number` is supported — a `buy:` request returns 400 buy_not_supported.
  addRoute("POST", "/api/v1/phone/provision", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const openaiKey = typeof b.openai_api_key === "string" ? b.openai_api_key.trim() : "";
    const accountSid = typeof b.twilio_account_sid === "string" ? b.twilio_account_sid.trim() : "";
    const authToken = typeof b.twilio_auth_token === "string" ? b.twilio_auth_token.trim() : "";
    if (!openaiKey || !accountSid || !authToken) {
      return sendJson(res, 400, {
        error: "openai_api_key, twilio_account_sid and twilio_auth_token are required",
        code: "missing_fields",
      });
    }

    // Number resolution: BYO `phone_number` is supported; `buy:` is not yet
    // wired (Lane V F70/F71) — fail clearly rather than block.
    if (b.buy !== undefined && (b.phone_number === undefined || b.phone_number === null || b.phone_number === "")) {
      return sendJson(res, 400, {
        error: "Buying a number is not yet supported on this tenant — provide an existing phone_number (BYO). TODO: wire Twilio number purchase (Lane V F70/F71).",
        code: "buy_not_supported",
      });
    }
    const phoneNumber = typeof b.phone_number === "string" ? b.phone_number.trim() : "";
    if (!phoneNumber) {
      return sendJson(res, 400, {
        error: "phone_number is required (BYO number)",
        code: "missing_phone_number",
      });
    }

    // Persist into the compose .env. TWILIO_PHONE_NUMBER is the name
    // readInstanceMeta() already reads for outbound SMS/calls.
    try {
      patchEnv({
        OPENAI_API_KEY: openaiKey,
        TWILIO_ACCOUNT_SID: accountSid,
        TWILIO_AUTH_TOKEN: authToken,
        TWILIO_PHONE_NUMBER: phoneNumber,
      });
    } catch (err: any) {
      return sendJson(res, 500, {
        error: `failed to persist credentials: ${err?.message ?? String(err)}`,
        code: "persist_failed",
      });
    }

    // Respond immediately, then (re)start voice-bridge in the background so it
    // reloads config from the new .env. --no-deps keeps ctrl-api untouched
    // (same pattern as PATCH /admin/credentials).
    sendJson(res, 200, { phone_number: phoneNumber, provisioned: true });
    dockerComposeCmd(["up", "-d", "--no-deps", "--force-recreate", "voice-bridge"]).catch((err) => {
      console.error("[phone/provision] voice-bridge restart failed:", err);
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

  // ── Inbound SMS routing (LEGACY — Hermes' twilio adapter owns this now) ──
  //
  // 2026-05-25 hard switch (Lane I, SMS-via-Hermes campaign). The SMS
  // inbound flow used to be: SaaS Twilio webhook → ctrl-api → openclaw
  // chat-completion → ship reply via SaaS. That implementation predates
  // the unified Hermes channel surface (`/api/v1/channels/sms/*` —
  // packages/ctrl/src/api/routes/sms.ts) and the one-Alfred UX promise
  // (see docs/design/one-alfred.md): Sir must feel he's talking to ONE
  // Alfred across every channel, with full continuity, not a per-channel
  // mini-bot stitching half-context together.
  //
  // The new path: Hermes' own twilio platform adapter is the inbound
  // listener. With the per-profile .env populated by /channels/sms/PUT
  // (Lane I), Twilio webhooks now hit Hermes directly — same as Telegram
  // and Slack — and outbound replies travel through /api/v1/alfred-deliver
  // so the alfred_journal records the entire exchange.
  //
  // This route is kept for ONE RELEASE so the SaaS twilio/sms webhook
  // doesn't 404 if it hasn't been re-pointed yet. Behaviour: ingest the
  // event into the stream pipeline (for audit + later vault enrichment),
  // warn-log so we can detect leftover callers, and return 200 so the
  // SaaS proxy doesn't retry-storm. No LLM completion, no Twilio reply —
  // Hermes owns the reply path now.
  //
  // Same one-release deprecation pattern as
  // `/api/v1/notifications` → `/api/v1/alfred-deliver` (notifications.ts).
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

    console.warn(
      "[phone/sms/inbound] LEGACY route hit (SaaS webhook not yet re-pointed at Hermes twilio adapter)",
    );

    const event = {
      id: cryptoRandomId(),
      stream_id: "sms-inbound",
      stream_type: "sms",
      received_at: new Date().toISOString(),
      source_ref: messageSid,
      raw: { from, to, body: text, direction: "inbound", path: "legacy" },
      summary: `SMS from ${from}: ${text.slice(0, 80)}`,
    };
    await ingestStreamEvent(event);
    sendJson(res, 200, {
      status: "stream-ingested",
      event_id: event.id,
      deprecated: true,
      replacement: "Hermes twilio adapter — see /api/v1/channels/sms/*",
    });
  });

  // ── Outbound SMS (LEGACY — agent-initiated; forwards to alfred-deliver) ──
  //
  // 2026-05-25 hard switch (Lane I, SMS-via-Hermes campaign). The outbound
  // SMS surface used to be: agent → POST /api/v1/phone/sms → SaaS
  // /api/internal/twilio/send-sms → Twilio. That bypassed alfred_journal,
  // so an outbound text NEVER appeared in Sir's "one-Alfred" continuity
  // (the journal is the source of truth main reads on every inbound).
  //
  // The new path: agent → POST /api/v1/alfred-deliver { channel: "sms", to }
  // → smsSend() (packages/ctrl/src/api/routes/sms.ts) → Twilio. The journal
  // is written BEFORE the send; on success it's marked delivered with the
  // exact bytes Sir saw.
  //
  // This route is kept for ONE RELEASE so any in-flight agent code calling
  // /api/v1/phone/sms keeps working unmodified. Body shape + response
  // shape preserved.
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

    // Forward to /api/v1/alfred-deliver (same-process self-call) so the
    // journal records the outbound and smsSend() does the actual Twilio
    // POST. Mirrors the notifications.ts → alfred-deliver forwarder.
    const aas = process.env.AAS_API_KEY || "";
    const port = process.env.AAS_PORT || "3100";
    let resp: Response;
    try {
      resp = await fetch(`http://127.0.0.1:${port}/api/v1/alfred-deliver`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aas}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: text,
          channel: "sms",
          to,
          source_kind: "phone-sms-legacy",
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: any) {
      sendJson(res, 502, {
        status: "ship-failed",
        error: `alfred-deliver unreachable: ${err?.message ?? String(err)}`,
      });
      return;
    }
    const respText = await resp.text().catch(() => "");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(respText);
    } catch {
      /* leave parsed = {} */
    }
    if (!resp.ok || !parsed.ok) {
      sendJson(res, resp.status || 502, {
        status: "ship-failed",
        error: (parsed.error as string) ?? `alfred-deliver returned ${resp.status}`,
      });
      return;
    }
    // alfred-deliver doesn't surface the Twilio message sid in its happy
    // path; preserve the legacy { status, sid } shape with journal_id as a
    // stand-in so callers grepping for sid don't crash on undefined.
    sendJson(res, 200, {
      status: "sent",
      sid: (parsed.journal_id as string) ?? null,
    });
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

    // One-Alfred continuity — Phase 3 of the /channels Phone wiring.
    // Every completed voice call becomes a journal row keyed by
    // (channel=voice, chat_id=<from_number>). The Hermes one-alfred plugin's
    // pre_llm_call hook injects recent journal entries for the resolved
    // principal across ALL channels — so Sir calls Alfred, hangs up, then
    // DMs five minutes later on Telegram, and Alfred has the call summary
    // in context. The principal_id auto-resolves via the binding (first
    // call from a new number creates an unbound entry; an operator can
    // later POST /api/v1/alfred-journal/principal/bind to link it).
    //
    // We bind preemptively in the realtime case because the alfred-voice
    // skill confirms the caller is Sir before any meaningful tool use, so
    // a transcript landing here is high-confidence Sir-spoken. If your
    // policy is different, rip the bind line out — the appendJournal call
    // works either way (it falls through to null principal_id).
    //
    // Failure is best-effort — never block the transcript ingest.
    try {
      const db = getStateDb();
      if (from) {
        bindPrincipalChannel(db, "voice", from, "owner");
      }
      appendJournal(db, {
        channel: "voice",
        chat_id: from || "unknown",
        direction: "outbound",
        message: summary,
        source_kind: "voice-call-transcript",
        source_ref: callId || event.source_ref,
        metadata: {
          to,
          started_at: startedAt,
          ended_at: endedAt,
          duration_seconds: durationSeconds(startedAt, endedAt),
          turn_count: transcript.length,
        },
      });
    } catch (err) {
      // Log and continue — the transcript is already in the stream log.
      console.warn(
        "[phone/transcript] alfred_journal append failed (non-blocking):",
        err instanceof Error ? err.message : err,
      );
    }

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
