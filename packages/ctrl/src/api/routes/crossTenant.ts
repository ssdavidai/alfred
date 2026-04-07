/**
 * Cross-tenant agent-to-agent communication.
 *
 * Admin-only feature: allows David's Alfred to ask questions to other tenants'
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
  const enrichedTask = [
    "IMPORTANT: Before answering, read these workspace files for context about your master:",
    "1. Read USER.md (your master's identity, work, clients, location)",
    "2. Read SOUL.md (how you should serve your master)",
    "3. Read MEMORY.md (long-term curated facts)",
    "Then answer the following question using the context from these files:",
    "",
    prompt,
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

  // Poll until done or timeout
  const pollInterval = 5_000;
  const deadline = start + timeoutMs;
  let lastAssistantText = "";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const histResult = (await gatewayInvoke("sessions_history", {
      sessionKey,
      limit: 10,
    })) as { result?: { details?: { status?: string; messages?: Array<{ role: string; content: unknown }> } } };

    const details = histResult?.result?.details;
    const messages = details?.messages || [];
    const status = details?.status || "";

    // Extract text from the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;

      // Content can be string or array of content blocks
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = (msg.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text!)
          .join("\n");
      }

      if (text) lastAssistantText = text;

      // Check for <final> tag (subagent completion marker)
      const finalMatch = text.match(/<final>([\s\S]*?)<\/final>/);
      if (finalMatch) {
        return {
          answer: finalMatch[1].trim(),
          sessionKey,
          durationMs: Date.now() - start,
        };
      }

      // Also accept if the session status indicates completion
      if (status === "completed" || status === "done") {
        return {
          answer: text.trim(),
          sessionKey,
          durationMs: Date.now() - start,
        };
      }

      break; // only inspect the last assistant message per poll
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
// Outbound call to a peer tenant (sending side — David only)
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
