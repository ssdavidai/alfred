/**
 * State-mutation Wasp operations [STATE-MUTATION Phase I — #897].
 *
 * Wasp queries that proxy through to the ctrl-api state-changes
 * endpoints shipped by Phase A (#889). These ops power the
 * Decisions "State Changes" tab, the matters/:id timeline expansion,
 * the chore Schedule editor's next-fires preview, and the admin
 * observability panels.
 *
 * All operations require an authenticated user and a running instance.
 * Errors propagate as HttpError so the dashboard can render them.
 */
import { HttpError } from "wasp/server";
import type {
  GetChoreScheduleFires,
  ApplyManualStateChange,
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";

// ---------------------------------------------------------------------------
// State-field allowlist mirror.
//
// Mirror of `packages/ctrl/src/api/stateFields.ts` so the SaaS frontend can
// diff a vault edit against the canonical list without a round-trip to
// ctrl-api. Keep in sync with ctrl on every state-field schema change.
// (Phase F, #894.)
// ---------------------------------------------------------------------------

export const MATTER_STATE_FIELDS = [
  "current_state",
  "as_of",
  "status",
  "surface_class",
  "last_briefing_at",
] as const;

export const TASK_STATE_FIELDS = [
  "current_state",
  "as_of",
  "status",
  "outcome",
  "pending_confirmation",
  "last_steward_outcome",
] as const;

export type StateFieldTarget = "matter" | "task";

export function classifyStateTarget(relPath: string): StateFieldTarget | null {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.startsWith("matter/") && normalized.endsWith(".md")) return "matter";
  if (normalized.startsWith("task/") && normalized.endsWith(".md")) return "task";
  return null;
}

export function stateFieldsFor(target: StateFieldTarget): readonly string[] {
  return target === "matter" ? MATTER_STATE_FIELDS : TASK_STATE_FIELDS;
}

/**
 * GET /api/v1/state-changes
 *
 * Paginated cross-target feed of every state_change timeline entry on
 * the tenant's matters + tasks. Filterable by target, source, since,
 * until. Returns { entries, total, limit, offset }.
 */
export const getStateChanges = async (
  args:
    | {
        target?: string;
        source?: string;
        since?: string;
        until?: string;
        limit?: number;
        offset?: number;
      }
    | void,
  context: any,
): Promise<any> => {
  const instance = await getUserInstance(context);
  const q: Record<string, string> = {};
  if (args && typeof args === "object") {
    if (args.target) q.target = args.target;
    if (args.source) q.source = args.source;
    if (args.since) q.since = args.since;
    if (args.until) q.until = args.until;
    if (typeof args.limit === "number") q.limit = String(args.limit);
    if (typeof args.offset === "number") q.offset = String(args.offset);
  }
  try {
    return await proxyToTenant(instance, {
      method: "GET",
      path: "/api/v1/state-changes",
      query: Object.keys(q).length ? q : undefined,
    });
  } catch {
    // Tenants without the endpoint render an empty list.
    return { entries: [], total: 0, limit: 0, offset: 0 };
  }
};

/**
 * GET /api/v1/state-changes/sources
 *
 * Distinct state-change sources seen in the last 30 days with counts
 * + last-seen timestamps. Powers the source-filter pills on the
 * Decisions State Changes tab.
 */
export const getStateChangeSources = async (
  _args: void,
  context: any,
): Promise<any> => {
  const instance = await getUserInstance(context);
  try {
    return await proxyToTenant(instance, {
      method: "GET",
      path: "/api/v1/state-changes/sources",
    });
  } catch {
    return { sources: [], window_start: "", window_end: "" };
  }
};

/**
 * GET /api/v1/cron/preview?expr=<cron>&count=N
 *
 * Returns the next N firing times for a 5-field cron expression.
 * Powers the Schedule editor's preview panel on /chores/:slug.
 * Server caches via mtime/in-memory; we hit it on every keystroke
 * with React Query staleness — 30s should be plenty.
 *
 * On invalid cron the endpoint returns 400 which proxyToTenant
 * surfaces as HttpError; we catch it and return `{ fires: [], error }`
 * so the editor can display the inline error without raising.
 */
export const getChoreScheduleFires: GetChoreScheduleFires<
  { slug?: string; cron: string; count?: number },
  any
> = async (args, context) => {
  if (!args?.cron || typeof args.cron !== "string") {
    return { fires: [], error: "cron expression is required" };
  }
  const instance = await getUserInstance(context);
  const q: Record<string, string> = { expr: args.cron };
  if (typeof args.count === "number") q.count = String(args.count);
  try {
    return await proxyToTenant(instance, {
      method: "GET",
      path: "/api/v1/cron/preview",
      query: q,
    });
  } catch (e: any) {
    // Surface validation errors inline; the editor uses `error` to render
    // the red invalid-cron caption beneath the input.
    return { fires: [], error: e?.message ?? "Failed to compute fires" };
  }
};

/**
 * POST /api/v1/state-changes
 *
 * Phase F (#894) — wraps manual vault-editor saves that touch a declared
 * state field. The SaaS frontend collects an optional `reason` from the
 * principal, sets `source=manual.<currentUserId>`, `confidence=1.0`,
 * `mode=live`, and proxies the envelope to ctrl-api which performs the
 * three-artefact atomic write (frontmatter patch + timeline append + audit
 * record). Non-state-field edits continue to use the legacy PATCH path —
 * splitting one save into a v2 POST for state fields plus a legacy PATCH
 * for everything else is the cleanest approach per spec §10.
 *
 * On 409 from ctrl-api (as_of mismatch), the error propagates as HttpError
 * with the conflict message; the VaultPage editor handles it by prompting
 * Reload or Force-Write.
 *
 * The `source` is built server-side from the authenticated user's id so
 * the client cannot spoof another writer's name. Wasp's User.id is a
 * lowercase UUID v4 (hyphens allowed in the SOURCE_RE post-Phase F).
 */
// All state-field values are scalars (current_state is a string; status is
// an enum string; as_of is ISO; pending_confirmation is bool;
// last_steward_outcome is a string/json-string from Steward). Constrain
// `fields` to a Payload-compatible scalar map so Wasp's SuperJSON typings
// accept it.
type StateFieldScalar = string | number | boolean | null;
type ApplyManualStateChangeArgs = {
  target_path: string;
  fields: Record<string, StateFieldScalar>;
  expected_as_of?: string | null;
  reason?: string;
};

type ApplyManualStateChangeResult = {
  audit_record_path: string;
  timeline_entry_id: string | null;
  new_as_of: string | null;
};

export const applyManualStateChange: ApplyManualStateChange<
  ApplyManualStateChangeArgs,
  ApplyManualStateChangeResult
> = async (args, context) => {
  if (!context.user) {
    throw new HttpError(401, "Not authenticated");
  }
  if (!args || typeof args.target_path !== "string" || !args.target_path) {
    throw new HttpError(400, "target_path is required");
  }
  const target = classifyStateTarget(args.target_path);
  if (!target) {
    throw new HttpError(
      400,
      "target_path must be a matter/*.md or task/*.md vault record",
    );
  }
  if (!args.fields || typeof args.fields !== "object" || Array.isArray(args.fields)) {
    throw new HttpError(400, "fields object is required");
  }
  const allow = new Set(stateFieldsFor(target));
  const fields: Record<string, StateFieldScalar> = {};
  for (const [k, v] of Object.entries(args.fields)) {
    if (!allow.has(k)) {
      throw new HttpError(
        400,
        `field '${k}' is not a declared state field for ${target}`,
      );
    }
    fields[k] = v;
  }
  if (Object.keys(fields).length === 0) {
    throw new HttpError(400, "fields must include at least one state field");
  }

  const userId = String(context.user.id);
  // Wasp's User.id is a lowercase UUID v4 (e.g. "8a3c1d2e-4b5f-...").
  // Phase F widened ctrl-api's SOURCE_RE to admit hyphens in segments after
  // the first dot so `manual.<uuid>` matches. We defensively strip any
  // character outside `[a-z0-9_-]` from the segment so a tampered DB value
  // can't smuggle a bad source through.
  const userIdSafe = userId.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!userIdSafe) {
    throw new HttpError(500, "Unable to derive a manual-source identifier");
  }
  const source = `manual.${userIdSafe}`;

  const reason =
    typeof args.reason === "string" && args.reason.trim().length > 0
      ? args.reason.trim()
      : "Manual edit — no reason given";

  const now = new Date().toISOString();
  const expectedRaw = args.expected_as_of;
  const expectedAsOf =
    typeof expectedRaw === "string" && expectedRaw ? expectedRaw : null;
  // observed_window: the principal "considered" whatever was on the matter
  // when the editor mounted. We have no signal/decision paths; that's fine,
  // the listing endpoint records signals=0 decisions=0 for manual edits.
  const observed_window = {
    start: expectedAsOf ?? now,
    end: now,
    signal_paths: [],
    decision_paths: [],
    other_refs: [],
  };

  const body: Record<string, unknown> = {
    target_path: args.target_path.replace(/\\/g, "/"),
    source,
    fields,
    observed_window,
    reason,
    confidence: 1.0,
    mode: "live",
  };
  if (expectedAsOf) {
    body.expected_as_of = expectedAsOf;
  }

  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/state-changes",
    body,
  });
};
