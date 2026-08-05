// intentRouterCore.ts — #425 deterministic fast-path.
//
// Answers a small set of *simple, unambiguous data-lookup* chat asks directly
// from ctrl-api, skipping the LLM entirely (a full agent turn is ~2s+ and can
// chain several tool calls; these are one HTTP read). This is the biggest
// interactive-latency lever (see EPIC #434) — Codex-only is unaffected, the LLM
// path is simply bypassed for these asks.
//
// SAFETY / DESIGN:
//   * CONSERVATIVE classifier — fires only on short, clearly-scoped asks; any
//     command-shaped or nuanced ask (create/why/how/plan/…) returns null.
//   * FAIL-OPEN everywhere — a non-match, an unexpected ctrl-api shape, or any
//     error returns null, and the caller falls through to the full agent. A
//     false-positive that returned a canned answer instead of engaging Alfred
//     is the failure mode we design against, so formatters return null rather
//     than guess when the data shape is unfamiliar.
//   * PURE — the ctrl-api fetch is injected (`CtrlGet`) so this is unit-testable
//     with no network.

export type IntentKey = "decisions" | "matters" | "chores" | "balance";

export interface IntentSpec {
  key: IntentKey;
  /** ctrl-api path to GET (already includes any query string). */
  ctrlPath: string;
}

/** Injected ctrl-api GET → parsed JSON (or throws / returns null on failure). */
export type CtrlGet = (path: string) => Promise<unknown>;

// Only fast-path short, direct asks. A long message is almost never a bare
// lookup — let the agent handle nuance.
const MAX_INPUT_CHARS = 90;

// If any of these appear, it's not a bare read — defer to the agent.
const NON_LOOKUP = /\b(create|add|new|update|change|edit|set|delete|remove|close|done|defer|snooze|draft|write|send|email|message|schedule|remind|pay|why|how|when|should|could|would|explain|plan|help|make|move|assign|complete|mark)\b/;

/**
 * Classify a chat input into a deterministic intent, or null to fall through.
 * Deliberately narrow: requires the intent noun plus a possessive/list signal,
 * rejects anything command-shaped.
 */
export function classifyIntent(rawInput: string): IntentSpec | null {
  if (typeof rawInput !== "string") return null;
  const s = rawInput.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s || s.length > MAX_INPUT_CHARS) return null;
  if (NON_LOOKUP.test(s)) return null;

  // pending / open decisions ("what's on my desk", "pending decisions")
  if (
    (/\bdecisions?\b/.test(s) &&
      /\b(pending|open|await(?:ing)?|waiting|outstanding|my|list|show|any|queue)\b/.test(s)) ||
    /\bmy desk\b/.test(s) ||
    /\bdecision queue\b/.test(s)
  ) {
    return { key: "decisions", ctrlPath: "/api/v1/decisions?state=open" };
  }

  // matters / plate ("what's on my plate", "my matters", "active matters")
  if (
    /\bmatters?\b/.test(s) ||
    /\bon my plate\b/.test(s) ||
    /\bmy plate\b/.test(s)
  ) {
    return { key: "matters", ctrlPath: "/api/v1/matters" };
  }

  // chores ("my chores", "chore status", "chores due")
  if (/\bchores?\b/.test(s)) {
    return { key: "chores", ctrlPath: "/api/v1/chores" };
  }

  // Sure balance ("my balance", "account balances", "net worth", "sure balance")
  if (
    /\bnet ?worth\b/.test(s) ||
    (/\bbalances?\b/.test(s) && /\b(my|account|accounts|sure|show|what)\b/.test(s)) ||
    (/\baccounts?\b/.test(s) && /\b(my|balance|balances|sure|show|list)\b/.test(s))
  ) {
    return { key: "balance", ctrlPath: "/api/v1/sure/accounts" };
  }

  return null;
}

// ── Formatters — defensive; return null on an unfamiliar shape ───────────────

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function fmtDecisions(data: any): string | null {
  const items = asArray(data?.decisions);
  if (!items) return null;
  if (items.length === 0) return "You have no pending decisions right now. ✅";
  const lines = items.slice(0, 10).map((d: any) => {
    const label =
      str(d?.summary) || str(d?.title) || str(d?.name) || str(d?.intent) || "(decision)";
    return `• ${label}`;
  });
  const more = items.length > 10 ? `\n…and ${items.length - 10} more.` : "";
  return `You have ${items.length} pending decision(s):\n${lines.join("\n")}${more}`;
}

function fmtMatters(data: any): string | null {
  const items = asArray(data?.matters);
  if (!items) return null;
  if (items.length === 0) return "No active matters.";
  const lines = items.slice(0, 12).map((m: any) => {
    const name = str(m?.name) || str(m?.path) || "(matter)";
    const state = str(m?.state);
    return state ? `• ${name} — ${state}` : `• ${name}`;
  });
  const more = items.length > 12 ? `\n…and ${items.length - 12} more.` : "";
  return `${items.length} matter(s) on your plate:\n${lines.join("\n")}${more}`;
}

function fmtChores(data: any): string | null {
  const items = asArray(data?.chores);
  if (!items) return null;
  if (items.length === 0) return "No chores configured.";
  const lines = items.slice(0, 12).map((c: any) => {
    const name = str(c?.name) || str(c?.slug) || "(chore)";
    const status = str(c?.status);
    const next = str(c?.next_run_at);
    const tail = [status, next && `next ${next}`].filter(Boolean).join(", ");
    return tail ? `• ${name} (${tail})` : `• ${name}`;
  });
  const more = items.length > 12 ? `\n…and ${items.length - 12} more.` : "";
  return `You have ${items.length} chore(s):\n${lines.join("\n")}${more}`;
}

function fmtBalance(data: any): string | null {
  const items = asArray(data?.accounts);
  if (!items) return null;
  if (items.length === 0) return "No accounts found in Sure.";
  const lines = items.slice(0, 15).map((a: any) => {
    const name = str(a?.name) || str(a?.institution_name) || "(account)";
    const bal = a?.balance ?? a?.cash_balance;
    const cur = str(a?.currency) || "";
    const shown =
      typeof bal === "number" || typeof bal === "string" ? `${bal} ${cur}`.trim() : "—";
    return `• ${name}: ${shown}`;
  });
  const more = items.length > 15 ? `\n…and ${items.length - 15} more.` : "";
  return `Your accounts (${items.length}):\n${lines.join("\n")}${more}`;
}

export function formatIntent(key: IntentKey, data: unknown): string | null {
  switch (key) {
    case "decisions":
      return fmtDecisions(data);
    case "matters":
      return fmtMatters(data);
    case "chores":
      return fmtChores(data);
    case "balance":
      return fmtBalance(data);
    default:
      return null;
  }
}

/**
 * The Hermes `/v1/responses` envelope the chat widget renders as a completed
 * turn (it reads `output[].content[].text` and requires `status: "completed"`).
 * A `fast_path` marker is added for observability; the widget ignores it.
 */
export function buildFastPathEnvelope(text: string, id: string): Record<string, unknown> {
  return {
    id,
    object: "response",
    status: "completed",
    fast_path: true,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Attempt the deterministic fast-path. Returns a ready `/v1/responses`
 * envelope on a confident hit, or null to fall through to the full agent.
 * FAIL-OPEN: any classification miss, unfamiliar ctrl-api shape, or thrown
 * error yields null.
 */
export async function tryFastPath(
  input: string,
  ctrlGet: CtrlGet,
  idFactory: () => string = () => `fastpath-${Date.now()}`,
): Promise<Record<string, unknown> | null> {
  const spec = classifyIntent(input);
  if (!spec) return null;
  try {
    const data = await ctrlGet(spec.ctrlPath);
    const text = formatIntent(spec.key, data);
    if (!text) return null; // unfamiliar shape — let the agent handle it
    return buildFastPathEnvelope(text, idFactory());
  } catch {
    return null; // ctrl-api unreachable / parse error — fall through
  }
}
