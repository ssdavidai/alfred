// ---------------------------------------------------------------------------
// STORE-P6-1: canonical vault path enforcement
//
// Phase 6 lock-down. The vault is bounded to the 12 record types the
// principal actually reads + edits. Every other persistent fact (audits,
// signals, observations, embeddings, raw streams) lives in state.db or
// JSONL. This middleware enforces that boundary at the ctrl-api ingress
// so future contributors (human or LLM) physically cannot regrow the
// original 88k-file mess.
//
// What is allowed as a write target via ctrl-api:
//   1. Records under one of the 12 canonical top-level vault dirs
//      (`matter/`, `task/`, `note/`, …).
//   2. Operator-tooling paths that intentionally bypass the contract
//      (templates, archived/migrated sweeps, raw inbox, etc.).
//   3. Three sacred root files: SOUL.md, RULES.md, CLAUDE.md.
//
// Enforcement is gated by CANONICAL_PATH_ENFORCEMENT:
//   - `enforce` (default) — return 400 on violation.
//   - `warn`              — log violation but allow the write.
//   - `off`               — bypass entirely (emergency rollback).
//
// Cuts vs the legacy KNOWN_TYPES list in routes/vault.ts (the data this
// type-set replaces, all of which is now state.db/JSONL territory):
//
//   project, event, process, account, conversation, input, run, session,
//   triage, assumption, constraint, contradiction, synthesis, observation,
//   reflection, ledger_entry, signal, needs_attention, stream_event,
//   signal_noise_pattern, pattern_proposal, location
//
// `observation` is preserved as a SQL endpoint suggestion (POST
// /api/v1/observations) — the data class continues to exist, just not
// as a vault file. Same for signals, audits, streams.
//
// `location` cuts to `place` (same data class, principal-facing
// vocabulary from the Alfred Black 1.0 redesign — see CLAUDE.md).
// ---------------------------------------------------------------------------

export const CANONICAL_VAULT_TYPES = new Set<string>([
  "matter",
  "task",
  "note",
  "person",
  "org",
  "place",
  "asset",
  "chore",
  "instinct",
  "briefing",
  "daybook",
  "decision",
]);

// Operator-tooling paths that bypass enforcement. These are not in
// CANONICAL_VAULT_TYPES because they aren't record types — they're
// physical staging areas the migration / rescue / archive tooling
// writes into. Matched against the leading directory of the relPath.
export const TOOLING_PATH_PATTERNS: RegExp[] = [
  /^_templates(\/|$)/,
  /^_archive(\/|$)/,
  /^_migrated[a-z_]*(\/|$)/,
  /^_rescue(\/|$)/,
  /^_raw(\/|$)/,
  /^_migrate(\/|$)/,
  // `inbox/` is the raw-upload staging area for /vault/inbox endpoints.
  // Treated as a tooling path rather than a vault type so the inbox
  // pipeline (alfred CLI's inbox-curator + alfred-learn's inbox watcher)
  // can keep its existing layout without forging a 13th canonical type.
  /^inbox(\/|$)/,
];

// Three sacred root-level files that the principal edits directly. Any
// other vault-root .md is rejected — there is no general escape hatch
// for ad-hoc top-level notes.
export const TOOLING_FILES: Set<string> = new Set<string>([
  "SOUL.md",
  "RULES.md",
  "CLAUDE.md",
]);

// Suggestion table for the most common rejections. Keys are the legacy
// top-level dir names that callers might still try to write into; the
// value is the redirection message we hand back so the caller can
// re-aim at the SQL endpoint. Kept narrow on purpose — anything not in
// the table gets a generic "this data class is not a vault type" line.
const SUGGESTION_BY_LEGACY_TYPE: Record<string, string> = {
  signal_action: "signal_action / steward_action records → POST /api/v1/audit",
  steward_action: "signal_action / steward_action records → POST /api/v1/audit",
  audit: "audit records → POST /api/v1/audit",
  signal: "signal/observation records → POST /api/v1/signals or /api/v1/observations",
  observation: "signal/observation records → POST /api/v1/signals or /api/v1/observations",
  needs_attention: "needs_attention records → POST /api/v1/signals (state.db routes them)",
  stream_event: "stream_event records → POST /api/v1/streams/events",
  event: "event records → POST /api/v1/streams/events",
  conversation: "conversation records → POST /api/v1/streams/events",
  input: "input records → POST /api/v1/streams/events",
  pattern_proposal: "pattern_proposal records → state.db pattern_proposals table",
  signal_noise_pattern: "signal_noise_pattern → state.db signal_noise_patterns table",
  reflection: "reflection records → POST /api/v1/observations (carrier=reflection)",
  triage: "triage records → triage is dropped; use note/ or task/ instead",
  assumption: "assumption / constraint / contradiction → state.db reasoning_facts table",
  constraint: "assumption / constraint / contradiction → state.db reasoning_facts table",
  contradiction: "assumption / constraint / contradiction → state.db reasoning_facts table",
  synthesis: "synthesis records → state.db reasoning_facts table",
  ledger_entry: "ledger_entry records → state.db audit table",
  project: "project → use matter/ instead (Alfred Black 1.0 vocabulary)",
  location: "location → use place/ instead (Alfred Black 1.0 vocabulary)",
  session: "session → use task/ or note/ (sessions live in state.db)",
  run: "run → state.db task_runs table",
  account: "account records → state.db accounts table (or asset/ for tracked accounts)",
  process: "process records → use chore/ or instinct/ instead",
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; suggestion?: string };

/**
 * Validate a relative vault write path against the canonical type set.
 *
 * Accepts relPath like `matter/foo.md`, `_templates/bar.md`, `SOUL.md`.
 * Returns ok=true if the path is a legal write target.
 */
export function validateVaultWritePath(relPath: string): ValidationResult {
  if (typeof relPath !== "string" || relPath.length === 0) {
    return { ok: false, reason: "Empty vault path" };
  }
  // Normalise away backslashes so a Windows-flavoured path still hits
  // the right top-level dir. Strip a leading slash (a few callers
  // accidentally pass `/matter/foo.md`).
  let p = relPath.replace(/\\/g, "/");
  if (p.startsWith("/")) p = p.slice(1);
  if (p.length === 0) {
    return { ok: false, reason: "Empty vault path" };
  }

  // Root-level sacred files. Only the exact match counts; case-sensitive.
  if (!p.includes("/") && TOOLING_FILES.has(p)) {
    return { ok: true };
  }

  // Anything else at vault root is rejected — there is no general
  // escape hatch for ad-hoc top-level notes (use note/ instead).
  if (!p.includes("/")) {
    return {
      ok: false,
      reason: `Root-level vault writes are not allowed: ${relPath}`,
      suggestion: "Use one of the 12 canonical type dirs (e.g. note/<slug>.md) or SOUL/RULES/CLAUDE.md",
    };
  }

  // Tooling path patterns (templates, archive, migrated, rescue, raw,
  // migrate). Matched against the full relpath so `_migrated_observations/x.md`
  // and `_migrate/y.md` both pass.
  for (const re of TOOLING_PATH_PATTERNS) {
    if (re.test(p)) return { ok: true };
  }

  // Top-level type dir.
  const topDir = p.split("/", 1)[0];
  if (CANONICAL_VAULT_TYPES.has(topDir)) {
    return { ok: true };
  }

  // Reject — build a helpful suggestion if we have one for this legacy
  // type name.
  const suggestion =
    SUGGESTION_BY_LEGACY_TYPE[topDir] ??
    `'${topDir}/' is not a canonical vault type. The 12 legal types are: ${Array.from(CANONICAL_VAULT_TYPES).sort().join(", ")}`;
  return {
    ok: false,
    reason: `Non-canonical vault write path: ${relPath}`,
    suggestion,
  };
}

// ---------------------------------------------------------------------------
// Enforcement mode (env-controlled)
// ---------------------------------------------------------------------------

export type EnforcementMode = "enforce" | "warn" | "off";

export function getEnforcementMode(): EnforcementMode {
  // Default is `enforce` — the four-store lockdown completed via the
  // STORE-P6-1-followup chain (#478): pattern_proposal, signal,
  // needs_attention, and event writers all migrated to SQL endpoints
  // (rounds A through G in commits 192190d → 762443a). Operators can
  // set the env to `warn` for a soak window before flipping a new
  // tenant, or `off` for emergency rollback.
  const raw = (process.env.CANONICAL_PATH_ENFORCEMENT ?? "enforce").toLowerCase();
  if (raw === "off" || raw === "warn" || raw === "enforce") return raw;
  // Unknown values fall back to enforce (fail-closed: the safe default
  // once the lockdown is in effect; mirrors the original P6-1 intent).
  return "enforce";
}

/**
 * Outcome from {@link enforceVaultWritePath}. When `block` is true the
 * caller MUST short-circuit the request with a 400; the `body` field
 * carries the canonical error envelope.
 */
export type EnforcementOutcome =
  | { block: false }
  | {
      block: true;
      body: {
        error: {
          code: "CANONICAL_PATH_VIOLATION";
          message: string;
          suggestion?: string;
          rejected_path: string;
        };
      };
    };

/**
 * Convenience wrapper: validates and applies CANONICAL_PATH_ENFORCEMENT.
 *
 * - mode=enforce + invalid → returns {block:true, body:{...}}
 * - mode=warn + invalid    → logs to stderr, returns {block:false}
 * - mode=off               → returns {block:false} unconditionally
 * - valid                  → returns {block:false}
 *
 * The handler decides whether to call `sendJson(res, 400, outcome.body)`
 * and return early — we don't take `res` here so the middleware stays
 * easy to unit-test.
 */
export function enforceVaultWritePath(relPath: string): EnforcementOutcome {
  const mode = getEnforcementMode();
  if (mode === "off") return { block: false };

  const result = validateVaultWritePath(relPath);
  if (result.ok) return { block: false };

  if (mode === "warn") {
    console.warn(
      `[canonical_path] WARN (would-reject under enforce) path=${relPath} reason=${result.reason}` +
        (result.suggestion ? ` suggestion=${result.suggestion}` : ""),
    );
    return { block: false };
  }

  return {
    block: true,
    body: {
      error: {
        code: "CANONICAL_PATH_VIOLATION",
        message: result.reason,
        ...(result.suggestion ? { suggestion: result.suggestion } : {}),
        rejected_path: relPath,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Inline smoke tests — `npx tsx src/api/middleware/canonical_path.ts` runs
// these. The block only fires when the file is the entrypoint of an ESM
// process; importing it from vault.ts is a no-op.
// ---------------------------------------------------------------------------

const _isEntrypoint = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metaUrl: string | undefined = (import.meta as any)?.url;
    if (!metaUrl) return false;
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return metaUrl.endsWith(argv1.replace(/\\/g, "/")) || metaUrl.endsWith("/canonical_path.ts");
  } catch {
    return false;
  }
})();

if (_isEntrypoint) {
  const cases: Array<{ path: string; expectOk: boolean; suggestionContains?: string }> = [
    { path: "matter/foo.md", expectOk: true },
    { path: "task/bar.md", expectOk: true },
    { path: "note/x.md", expectOk: true },
    { path: "person/y.md", expectOk: true },
    { path: "place/z.md", expectOk: true },
    { path: "asset/a.md", expectOk: true },
    { path: "chore/b.md", expectOk: true },
    { path: "instinct/c.md", expectOk: true },
    { path: "briefing/d.md", expectOk: true },
    { path: "daybook/e.md", expectOk: true },
    { path: "decision/f.md", expectOk: true },
    { path: "org/g.md", expectOk: true },
    { path: "_templates/bar.md", expectOk: true },
    { path: "_archive/old.md", expectOk: true },
    { path: "_migrated_observations/o.md", expectOk: true },
    { path: "_rescue/r.md", expectOk: true },
    { path: "_raw/inbox.md", expectOk: true },
    { path: "_migrate/x.md", expectOk: true },
    { path: "SOUL.md", expectOk: true },
    { path: "RULES.md", expectOk: true },
    { path: "CLAUDE.md", expectOk: true },
    { path: "event/signal-action-foo.md", expectOk: false, suggestionContains: "/streams/events" },
    { path: "signal/foo.md", expectOk: false, suggestionContains: "/signals" },
    { path: "stream_event/foo.md", expectOk: false, suggestionContains: "/streams/events" },
    { path: "audit/foo.md", expectOk: false, suggestionContains: "/audit" },
    { path: "observation/o.md", expectOk: false, suggestionContains: "/observations" },
    { path: "random-junk/foo.md", expectOk: false },
    { path: "rogue-root-file.md", expectOk: false },
    { path: "", expectOk: false },
  ];

  let failures = 0;
  for (const c of cases) {
    const r = validateVaultWritePath(c.path);
    const okMatches = r.ok === c.expectOk;
    let suggestionMatches = true;
    if (!c.expectOk && c.suggestionContains) {
      suggestionMatches = !r.ok && (r.suggestion ?? "").includes(c.suggestionContains);
    }
    if (!okMatches || !suggestionMatches) {
      failures++;
      console.error(
        `FAIL path=${JSON.stringify(c.path)} got=${JSON.stringify(r)} expected ok=${c.expectOk}` +
          (c.suggestionContains ? ` suggestionContains=${c.suggestionContains}` : ""),
      );
    } else {
      console.log(`PASS path=${JSON.stringify(c.path)} ok=${r.ok}`);
    }
  }
  if (failures > 0) {
    console.error(`canonical_path: ${failures} test failure(s)`);
    process.exit(1);
  } else {
    console.log(`canonical_path: all ${cases.length} cases passed`);
  }
}
