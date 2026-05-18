/**
 * Cross-tenant agent-to-agent communication.
 *
 * Admin-only feature: allows Sir's Alfred to ask questions to other tenants'
 * Alfreds via the Tailscale mesh. Each tenant gets a receiving endpoint; the
 * sending tool is only active when CROSS_TENANT_PEERS is set in the env.
 */
import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";

// ---------------------------------------------------------------------------
// Peer configuration
// ---------------------------------------------------------------------------

interface PeerConfig {
  id: string;
  tailscaleIp: string;
  tailscaleHost?: string; // e.g. "alfred-alfred-miguel-mnd9thwe.tail5ec603.ts.net"
  apiKey: string;
  label: string;
}

function loadPeers(): Map<string, PeerConfig> {
  const raw = process.env.CROSS_TENANT_PEERS;
  if (!raw) return new Map();
  try {
    const peers: PeerConfig[] = JSON.parse(raw);
    return new Map(peers.map((p) => [p.id, p]));
  } catch {
    console.error("[cross-tenant] Failed to parse CROSS_TENANT_PEERS");
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Gateway helpers (for the receiving side)
// ---------------------------------------------------------------------------

const GATEWAY_TOKEN_PATHS = [
  "/alfred-data/.gateway-token",
  "/mnt/encrypted/alfred/.gateway-token",
  "/app/data/.gateway-token",
];
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://openclaw:18789";

function getGatewayToken(): string {
  for (const p of GATEWAY_TOKEN_PATHS) {
    try {
      const token = fs.readFileSync(p, "utf-8").trim();
      if (token) return token;
    } catch { /* try next */ }
  }
  return process.env.OPENCLAW_GATEWAY_TOKEN || "";
}

async function gatewayInvoke(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const token = getGatewayToken();
  if (!token) throw new Error("Gateway token not available");

  const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tool, args }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gateway ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Spawn a session and poll for the answer (receiving side)
// ---------------------------------------------------------------------------

async function spawnAndPoll(
  prompt: string,
  timeoutMs: number,
): Promise<{ answer: string; sessionKey: string; durationMs: number }> {
  const start = Date.now();

  // Prepend instructions to read workspace context files — the bootstrap may
  // truncate them if AGENTS.md is too large, so explicitly tell the subagent
  // to read them from disk.
  //
  // We also instruct the subagent to wrap its FINAL answer in <final>...</final>
  // tags so the polling loop below can deterministically detect completion.
  // The poll loop has a tagless fallback for Alfreds who forget to wrap
  // (see TURNS_BEFORE_TAGLESS_FALLBACK), but the explicit form is preferred.
  const enrichedTask = [
    "IMPORTANT: Before answering, you MUST read these files using the read tool with EXACT paths:",
    "1. Read file at path: ~/.openclaw/workspace/USER.md",
    "2. Read file at path: ~/.openclaw/workspace/SOUL.md",
    "3. Read file at path: ~/.openclaw/workspace/MEMORY.md",
    "These files contain your master's identity, preferences, clients, and curated facts.",
    "Use the information from these files to answer this question:",
    "",
    prompt,
    "",
    "When you have your final answer, wrap it in <final>...</final> tags on a line by itself, e.g.:",
    "<final>The answer is X because Y.</final>",
    "Do not include commentary outside the tags. The relay returns only the wrapped content.",
  ].join("\n");

  // Spawn
  const spawnResult = (await gatewayInvoke("sessions_spawn", {
    task: enrichedTask,
    agentId: "main",
    mode: "run",
    runTimeoutSeconds: Math.floor(timeoutMs / 1000),
  })) as { result?: { details?: { childSessionKey?: string } } };

  const sessionKey = spawnResult?.result?.details?.childSessionKey;
  if (!sessionKey) {
    throw new Error("sessions_spawn did not return a childSessionKey");
  }

  // After this many text-bearing assistant turns, we accept the most recent
  // assistant text as the final answer even without <final>...</final> tags.
  // The relay's enriched task instructs the agent to read 3 files (USER/SOUL/
  // MEMORY) before answering, so realistic conversational shape is:
  //   1–3: tool-call turns to read each file (no text)
  //   4+ : the actual reasoned reply
  // Setting the threshold at 4 means we wait for at least one substantive
  // reply turn but bail out before pure timeout.
  const TURNS_BEFORE_TAGLESS_FALLBACK = 4;

  // Poll until done or timeout. Interval overridable via env for tests
  // (default 5s in production keeps gateway pressure low).
  const pollInterval = Math.max(
    50,
    Number(process.env.CROSS_TENANT_POLL_INTERVAL_MS) || 5_000,
  );
  const deadline = start + timeoutMs;
  let lastAssistantText = "";
  let assistantTextTurns = 0; // number of assistant messages with non-empty text seen so far
  let lastSeenAssistantTextSig = ""; // dedupe text-turn counting across polls

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const histResult = (await gatewayInvoke("sessions_history", {
      sessionKey,
      limit: 50,
    })) as { result?: { details?: { status?: string; messages?: Array<{ role: string; content: unknown }> } } };

    const details = histResult?.result?.details;
    const messages = details?.messages || [];
    const status = details?.status || "";

    // Walk all assistant messages this poll so we can count turns and find
    // the most recent text-bearing one. We intentionally ignore tool-call /
    // tool-result turns (which surface as content blocks of type "tool_use"
    // / "tool_result" and produce no extracted text).
    let lastTextThisPoll = "";
    let turnCount = 0;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;

      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = (msg.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text!)
          .join("\n");
      }

      if (text) {
        turnCount += 1;
        lastTextThisPoll = text;
      }
    }

    // Refresh state for downstream checks
    if (lastTextThisPoll) lastAssistantText = lastTextThisPoll;
    // Only update the count when the latest text differs from what we last
    // saw (the messages list is cumulative — re-counting every poll would
    // double-count turns that haven't changed).
    const sig = `${turnCount}::${lastTextThisPoll.slice(-200)}`;
    if (sig !== lastSeenAssistantTextSig) {
      assistantTextTurns = turnCount;
      lastSeenAssistantTextSig = sig;
    }

    // ── Primary completion path: explicit <final>...</final> wrapper ────────
    const finalMatch = lastAssistantText.match(/<final>([\s\S]*?)<\/final>/);
    if (finalMatch) {
      return {
        answer: finalMatch[1].trim(),
        sessionKey,
        durationMs: Date.now() - start,
      };
    }

    // ── Secondary: explicit session-status completion ───────────────────────
    if (status === "completed" || status === "done") {
      return {
        answer: lastAssistantText.trim(),
        sessionKey,
        durationMs: Date.now() - start,
      };
    }

    // ── Tertiary: tagless fallback ──────────────────────────────────────────
    // If we've seen enough assistant-text turns and the last one isn't an
    // empty tool-only artefact, treat it as the final answer. This covers
    // the case where the peer's Alfred answers cleanly but forgets to wrap
    // in <final> tags. We only fire after TURNS_BEFORE_TAGLESS_FALLBACK so
    // we don't grab a mid-thought "let me check that" intermediate turn.
    if (
      assistantTextTurns >= TURNS_BEFORE_TAGLESS_FALLBACK &&
      lastAssistantText.trim().length > 0
    ) {
      return {
        answer: lastAssistantText.trim(),
        sessionKey,
        durationMs: Date.now() - start,
      };
    }

    // Detect billing / LLM errors surfaced as session content or error status.
    // OpenClaw surfaces billing errors (402) as assistant messages containing
    // "billing error" and may set status to "error" or "failed".
    const billingPattern = /billing error|out of credits|insufficient balance|402/i;

    if (billingPattern.test(lastAssistantText)) {
      return {
        answer: `[error: The target tenant's LLM provider returned a billing error — their API key has run out of credits or has an insufficient balance. The remote Alfred cannot respond until credits are topped up.]`,
        sessionKey,
        durationMs: Date.now() - start,
      };
    }

    // Catch error/failed session status early instead of polling until timeout
    if (status === "error" || status === "failed") {
      const detail = lastAssistantText
        ? lastAssistantText.slice(0, 500)
        : "no details available";
      return {
        answer: `[error: Remote session failed — ${detail}]`,
        sessionKey,
        durationMs: Date.now() - start,
      };
    }
  }

  // Timeout — return whatever partial content we captured so the caller
  // gets useful diagnostic info instead of a bare "timeout" message.
  if (lastAssistantText) {
    return {
      answer: `[timeout — the remote Alfred did not produce a final answer within ${Math.round(timeoutMs / 1000)}s. Partial content: ${lastAssistantText.slice(0, 1000)}]`,
      sessionKey,
      durationMs: Date.now() - start,
    };
  }

  return {
    answer: `[timeout — the remote Alfred produced no response within ${Math.round(timeoutMs / 1000)}s. This may indicate the tenant's LLM provider is unavailable or out of credits.]`,
    sessionKey,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Outbound call to a peer tenant (sending side — Sir only)
// ---------------------------------------------------------------------------

export async function crossTenantAsk(
  tenantId: string,
  prompt: string,
  timeoutSeconds: number = 300,
): Promise<{ answer: string; tenant: string; sessionKey: string; durationMs: number }> {
  const peers = loadPeers();
  const peer = peers.get(tenantId);
  if (!peer) {
    const available = [...peers.keys()].join(", ") || "(none configured)";
    throw new ValidationError(`Unknown tenant "${tenantId}". Available peers: ${available}`);
  }

  // Use Tailscale hostname with HTTPS (Tailscale Serve terminates TLS)
  const host = peer.tailscaleHost || peer.tailscaleIp;
  const proto = peer.tailscaleHost ? "https" : "http";
  const url = `${proto}://${host}:3100/api/v1/cross-tenant/ask`;
  console.log(`[cross-tenant] Asking ${peer.label} (${peer.tailscaleIp}): ${prompt.slice(0, 80)}...`);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${peer.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      callerId: "admin",
      timeoutSeconds,
    }),
    signal: AbortSignal.timeout((timeoutSeconds + 30) * 1000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Peer ${peer.label} returned ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { answer: string; sessionKey: string; durationMs: number };

  console.log(`[cross-tenant] Got answer from ${peer.label} in ${data.durationMs}ms`);

  return {
    answer: data.answer,
    tenant: peer.label,
    sessionKey: data.sessionKey,
    durationMs: data.durationMs,
  };
}

// ---------------------------------------------------------------------------
// Generic proxy to any peer tenant ctrl-api (IDDQD — admin only)
// ---------------------------------------------------------------------------

export async function crossTenantProxy(
  tenantId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown; tenant: string }> {
  const peers = loadPeers();
  const peer = peers.get(tenantId);
  if (!peer) {
    const available = [...peers.keys()].join(", ") || "(none configured)";
    throw new ValidationError(`Unknown tenant "${tenantId}". Available peers: ${available}`);
  }

  if (!path.startsWith("/api/v1/")) {
    throw new ValidationError("Path must start with /api/v1/");
  }

  const host = peer.tailscaleHost || peer.tailscaleIp;
  const proto = peer.tailscaleHost ? "https" : "http";
  const url = `${proto}://${host}:3100${path}`;

  const upperMethod = method.toUpperCase();
  console.log(`[iddqd] ${upperMethod} ${path} → ${peer.label}`);

  const fetchOptions: RequestInit = {
    method: upperMethod,
    headers: {
      Authorization: `Bearer ${peer.apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  };

  if (body && upperMethod !== "GET" && upperMethod !== "HEAD") {
    fetchOptions.body = JSON.stringify(body);
  }

  const resp = await fetch(url, fetchOptions);
  const contentType = resp.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await resp.json()
    : await resp.text();

  return { status: resp.status, data, tenant: peer.label };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerCrossTenantRoutes(): void {
  // ── Receiving endpoint (all tenants) ──────────────────────────────────
  addRoute("POST", "/api/v1/cross-tenant/ask", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.prompt !== "string" || !b.prompt.trim()) {
      throw new ValidationError("prompt (string) is required");
    }

    const prompt = (b.prompt as string).slice(0, 8000);
    const callerId = typeof b.callerId === "string" ? b.callerId : "unknown";
    const timeoutSeconds = Math.min(Number(b.timeoutSeconds) || 300, 480);

    console.log(`[cross-tenant] Received ask from ${callerId}: ${prompt.slice(0, 80)}...`);

    try {
      const result = await spawnAndPoll(prompt, timeoutSeconds * 1000);
      sendJson(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cross-tenant] Ask failed:`, msg);
      sendJson(res, 200, { answer: `[error: ${msg}]`, sessionKey: "", durationMs: 0 });
    }
  });

  // ── List peers (admin only — only works if CROSS_TENANT_PEERS is set) ─
  addRoute("GET", "/api/v1/cross-tenant/peers", async ({ res }) => {
    const peers = loadPeers();
    const list = [...peers.values()].map((p) => ({
      id: p.id,
      label: p.label,
      tailscaleIp: p.tailscaleIp,
    }));
    sendJson(res, 200, { peers: list });
  });
}
