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
  tailscaleHost?: string; // e.g. "alfred-tenant-b-example.tailnet.ts.net"
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
// Hermes runtime helpers (for the receiving side)
//
// Phase 2: the receiving side calls the Hermes `/v1/runs` API natively. The
// request goes straight to the Hermes API server, which binds the canonical
// port on the compose network (the hermes-shim was retired in issue #40).
// The OpenClaw `sessions_spawn`/`sessions_history` `/tools/invoke` contract
// is retired.
// ---------------------------------------------------------------------------

const GATEWAY_TOKEN_PATHS = [
  "/alfred-data/.gateway-token",
  "/mnt/encrypted/alfred/.gateway-token",
  "/app/data/.gateway-token",
];
// The main-profile gateway: cross-tenant asks are answered by the principal-
// facing Alfred (full memory + workspace), not the workers profile.
const GATEWAY_URL =
  process.env.HERMES_GATEWAY_URL ||
  process.env.OPENCLAW_GATEWAY_URL ||
  "http://hermes:18789";

function getGatewayToken(): string {
  for (const p of GATEWAY_TOKEN_PATHS) {
    try {
      const token = fs.readFileSync(p, "utf-8").trim();
      if (token) return token;
    } catch { /* try next */ }
  }
  return process.env.HERMES_API_KEY || process.env.OPENCLAW_GATEWAY_TOKEN || "";
}

/** Create a Hermes run. Returns the run object. */
async function hermesCreateRun(
  token: string,
  input: string,
  sessionId: string,
  instructions: string,
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${GATEWAY_URL}/v1/runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input, session_id: sessionId, instructions }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Hermes /v1/runs ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as Record<string, unknown>;
}

/** Fetch current Hermes run status. */
async function hermesGetRun(
  token: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${GATEWAY_URL}/v1/runs/${encodeURIComponent(runId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Hermes GET /v1/runs ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as Record<string, unknown>;
}

/** Extract the final assistant text from a Hermes run object. */
function extractRunText(run: Record<string, unknown>): string {
  const output = run.output;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      if (it.type !== "message") continue;
      const content = it.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === "object") {
            const cc = c as Record<string, unknown>;
            if ((cc.type === "output_text" || cc.type === "text") && typeof cc.text === "string") {
              parts.push(cc.text);
            }
          }
        }
      } else if (typeof content === "string") {
        parts.push(content);
      }
    }
    return parts.filter(Boolean).join("\n");
  }
  if (typeof run.text === "string") return run.text;
  return "";
}

// ---------------------------------------------------------------------------
// Start a Hermes run and poll for the answer (receiving side)
// ---------------------------------------------------------------------------

async function spawnAndPoll(
  prompt: string,
  timeoutMs: number,
): Promise<{ answer: string; sessionKey: string; durationMs: number }> {
  const start = Date.now();
  const token = getGatewayToken();
  if (!token) throw new Error("Gateway token not available");

  // The peer's Alfred is asked to wrap its FINAL answer in <final>...</final>
  // tags so we can deterministically detect completion. A tagless fallback
  // (the terminal run output once the run finishes) covers Alfreds that
  // forget the wrapper.
  const enrichedInput = [
    "IMPORTANT: Before answering, read your workspace context files (USER, SOUL,",
    "MEMORY) so your reply reflects your master's identity, preferences, and",
    "curated facts. Then answer this question:",
    "",
    prompt,
    "",
    "When you have your final answer, wrap it in <final>...</final> tags on a line",
    "by itself, e.g. <final>The answer is X because Y.</final>. Do not include",
    "commentary outside the tags — the relay returns only the wrapped content.",
  ].join("\n");

  const instructions =
    "You are the principal-facing Alfred answering a relayed question from a " +
    "peer instance. Reply concisely and wrap your final answer in <final> tags.";

  // session_id = a fresh per-ask id so the relay never threads onto a live
  // principal conversation.
  const sessionId = `xtenant-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const run = await hermesCreateRun(token, enrichedInput, sessionId, instructions);
  const runId = String(run.id ?? run.run_id ?? "");
  if (!runId) {
    throw new Error("Hermes /v1/runs did not return a run id");
  }

  const pollInterval = Math.max(
    50,
    Number(process.env.CROSS_TENANT_POLL_INTERVAL_MS) || 5_000,
  );
  const deadline = start + timeoutMs;
  const terminal = new Set([
    "completed",
    "succeeded",
    "done",
    "failed",
    "cancelled",
    "error",
  ]);
  let lastText = "";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    let cur: Record<string, unknown>;
    try {
      cur = await hermesGetRun(token, runId);
    } catch {
      continue; // transient — keep polling
    }

    const status = String(cur.status ?? "").toLowerCase();
    const text = extractRunText(cur);
    if (text) lastText = text;

    // ── Primary: explicit <final>...</final> wrapper ────────────────────────
    const finalMatch = lastText.match(/<final>([\s\S]*?)<\/final>/);
    if (finalMatch) {
      return { answer: finalMatch[1].trim(), sessionKey: runId, durationMs: Date.now() - start };
    }

    // ── Billing / credit failures surfaced in the run output ────────────────
    const billingPattern = /billing error|out of credits|insufficient balance|402/i;
    if (billingPattern.test(lastText)) {
      return {
        answer:
          "[error: The target tenant's LLM provider returned a billing error — " +
          "their API key has run out of credits or has an insufficient balance. " +
          "The remote Alfred cannot respond until credits are topped up.]",
        sessionKey: runId,
        durationMs: Date.now() - start,
      };
    }

    // ── Terminal run state ──────────────────────────────────────────────────
    if (terminal.has(status)) {
      if (status === "failed" || status === "error" || status === "cancelled") {
        const detail = lastText
          ? lastText.slice(0, 500)
          : String(cur.error ?? cur.detail ?? "no details available");
        return {
          answer: `[error: Remote run ${status} — ${detail}]`,
          sessionKey: runId,
          durationMs: Date.now() - start,
        };
      }
      // Completed without <final> tags — return the terminal output verbatim.
      return { answer: lastText.trim(), sessionKey: runId, durationMs: Date.now() - start };
    }
  }

  // Timeout — return whatever partial content we captured.
  if (lastText) {
    return {
      answer: `[timeout — the remote Alfred did not produce a final answer within ${Math.round(timeoutMs / 1000)}s. Partial content: ${lastText.slice(0, 1000)}]`,
      sessionKey: runId,
      durationMs: Date.now() - start,
    };
  }
  return {
    answer: `[timeout — the remote Alfred produced no response within ${Math.round(timeoutMs / 1000)}s. This may indicate the tenant's LLM provider is unavailable or out of credits.]`,
    sessionKey: runId,
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
