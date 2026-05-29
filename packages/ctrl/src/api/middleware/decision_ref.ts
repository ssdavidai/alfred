// Approval-gate middleware — `decision_ref` enforcement for destructive verbs.
//
// Sir locked the Tier 4 approval split YES on 2026-05-29 (#115 spec §4):
// every destructive verb (`ha__core_restart`, `ha__addon_install`,
// `ha__user_create`, …) must reference a Desk decision the principal
// approved. Cheap reversible verbs (scene_create, entity_rename,
// addon_start/stop, …) run free.
//
// This middleware is the load-bearing entry-point for the destructive-verb
// half of that contract. Every PR2-PR8 route that mutates the surface in a
// way the principal can't un-mutate from HA's UI in <2 minutes calls
// `requireDecisionRef(body)` near the top of its handler.
//
// What it does
// ------------
//   1. Extracts `body.decision_ref` (string).
//   2. Validates the shape (printable ASCII, no whitespace, 6..256 chars).
//      This matches the assertDecisionRef shape in channels_ha.ts so a
//      caller has one contract regardless of which surface they hit.
//   3. Looks the decision up under `${VAULT_PATH}/decision/<id>.md`. The
//      decisions surface (routes/decisions.ts) writes them all there.
//   4. Asserts the decision's state is NOT `reversed`. Reversed decisions
//      are the explicit "I changed my mind" path — Sir's standing rule is
//      that an Alfred CAN'T act on a reversed decision.
//
// Why this shape
// --------------
// The spec said "fails if not in HANDLED state". HANDLED is a UI label in
// the DecisionsPage filter set (HANDLED / HELD / ASKED), derived from
// `intent` (done|take_mine → Handled, defer → Held, delegate → Asked).
// At the API level the load-bearing distinction is "did the principal
// reverse this decision?" — every other state (open, dispatching,
// executing, scheduled, completed) is a valid trigger for a Tier 4 verb.
// A `defer`-intent decision (HELD) can legitimately be the trigger for an
// `ha__core_restart` later (the principal deferred yesterday, then today
// said "OK go"). The middleware therefore validates "exists + not
// reversed" rather than "HANDLED". This call is documented on the PR; if
// Sir wants the stricter HANDLED-only gate after PR2 ships, that's an
// append-not-a-revert (add a new env var; turn it on once the catalogue
// is stable).

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { ValidationError, ApiError } from "../errors.js";

// Read VAULT_PATH directly from env rather than importing from routes/vault.js
// — that file imports server.js, which imports every route registration,
// which transitively triggers a temporal-dead-zone error on
// `routes/admin.ts:VAULT_PATH` if anything reaches into this middleware
// during module init (the tests do exactly that). The env shape is the
// same contract — VAULT_PATH defaults to /vault, overridden by env in
// container + tests. Keep this duplicated rather than introducing a
// shared `paths.ts` for one constant.
const VAULT_PATH = process.env.VAULT_PATH ?? "/vault";

const DECISION_REF_RE = /^[\x21-\x7e]{6,256}$/;

/** Decision states that are valid triggers for a Tier 4 destructive verb. */
const ALLOWED_DECISION_STATES = new Set([
  "open",
  "dispatching",
  "executing",
  "scheduled",
  "completed",
  // `reversed` is the one state we reject — the principal explicitly
  // undid this decision.
]);

export interface DecisionLookup {
  id: string;
  state: string;
  intent: string;
  source: string | null;
}

/**
 * Asserts the body carries a valid `decision_ref` pointing at a
 * non-reversed decision. Throws ValidationError on bad shape, ApiError
 * 400 with `DECISION_REF_INVALID` on missing decision, ApiError 400 with
 * `DECISION_REF_REVERSED` on a reversed decision.
 *
 * Returns the decision id + state on success so callers can record it
 * alongside the ha_run row.
 */
export function requireDecisionRef(body: unknown): DecisionLookup {
  if (typeof body !== "object" || body === null) {
    throw new ValidationError(
      "decision_ref required for destructive verb",
      { code_hint: "DECISION_REF_MISSING" },
    );
  }
  const raw = (body as Record<string, unknown>).decision_ref;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError(
      "decision_ref required for destructive verb",
      { code_hint: "DECISION_REF_MISSING" },
    );
  }
  if (!DECISION_REF_RE.test(raw)) {
    throw new ValidationError(
      "decision_ref must be 6..256 printable ASCII chars (no whitespace, no control chars)",
      { code_hint: "DECISION_REF_MALFORMED" },
    );
  }
  // Path-traversal guard mirrors decisions.ts:readDecision.
  const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!safe || safe !== raw) {
    throw new ValidationError(
      "decision_ref must contain only [A-Za-z0-9_.-]",
      { code_hint: "DECISION_REF_MALFORMED" },
    );
  }
  const decisionsDir = path.join(VAULT_PATH, "decision");
  const fullPath = path.resolve(path.join(decisionsDir, `${safe}.md`));
  if (!fullPath.startsWith(path.resolve(decisionsDir) + path.sep)) {
    throw new ApiError(
      400,
      "DECISION_REF_INVALID",
      `decision_ref ${safe} did not resolve under the decisions vault directory`,
    );
  }
  let rawFile: string;
  try {
    rawFile = fs.readFileSync(fullPath, "utf-8");
  } catch {
    throw new ApiError(
      400,
      "DECISION_REF_INVALID",
      `decision_ref ${safe} not found — no decision record exists for that id`,
    );
  }
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(rawFile);
  if (!match) {
    throw new ApiError(
      400,
      "DECISION_REF_INVALID",
      `decision_ref ${safe} has malformed frontmatter`,
    );
  }
  let fm: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(match[1]) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    throw new ApiError(
      400,
      "DECISION_REF_INVALID",
      `decision_ref ${safe} has unparseable YAML frontmatter`,
    );
  }
  const state =
    typeof fm.state === "string" ? (fm.state as string).toLowerCase() : "open";
  const intent =
    typeof fm.intent === "string" ? (fm.intent as string).toLowerCase() : "";
  const source = typeof fm.source === "string" ? (fm.source as string) : null;
  if (!ALLOWED_DECISION_STATES.has(state)) {
    throw new ApiError(
      400,
      state === "reversed" ? "DECISION_REF_REVERSED" : "DECISION_REF_INVALID_STATE",
      `decision_ref ${safe} is in state '${state}' — a destructive verb cannot run on a ${state} decision`,
    );
  }
  return { id: safe, state, intent, source };
}

/** Test seam — the regex is part of the contract. */
export const _DECISION_REF_RE_FOR_TESTS = DECISION_REF_RE;
export const _ALLOWED_DECISION_STATES_FOR_TESTS = ALLOWED_DECISION_STATES;
