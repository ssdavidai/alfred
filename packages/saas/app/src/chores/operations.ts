/**
 * Chores Wasp operations [Plan C.2]
 *
 * Wasp queries and actions that proxy through to the tenant ctrl-api
 * routes that already exist from the S4 chore-system work. This file
 * is the wire layer between the new Chores tab UI (C.3) and the
 * existing per-tenant chore management endpoints.
 *
 * All operations require an authenticated user and a running instance.
 * Errors propagate as HttpError so the dashboard can render them.
 */
import type {
  GetChores,
  GetChore,
  GetChoreSource,
  GetChoreRuns,
  PauseChore,
  ResumeChore,
  DeleteChore,
  TriggerChore,
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";

/**
 * GET /api/v1/chores
 *
 * Lists every chore vault record on the user's tenant. The ctrl-api
 * route returns the parsed frontmatter for each so the dashboard can
 * render the list view without making N follow-up calls.
 *
 * Returns an array of chore summaries: name, status, schedule,
 * user_facing_description (if present), template, last_run, etc.
 */
export const getChores: GetChores<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/chores",
  });
};

/**
 * GET /api/v1/chores/:slug
 *
 * Single chore detail — frontmatter + body so the detail page can
 * render the description, run log, and (collapsed) source code.
 */
export const getChore: GetChore<{ slug: string }, any> = async (
  args,
  context,
) => {
  if (!args?.slug || typeof args.slug !== "string") {
    throw new Error("slug is required");
  }
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: `/api/v1/chores/${encodeURIComponent(args.slug)}`,
  });
};

/**
 * GET /api/v1/chores/:slug/source
 *
 * Returns the full generated Python source + a data-readiness audit
 * of the chore_actions the workflow calls. Used by the Chores detail
 * page to render the actual code + an anti-hallucination check showing
 * whether the tenant has the data each activity depends on.
 */
export const getChoreSource: GetChoreSource<{ slug: string }, any> = async (
  args,
  context,
) => {
  if (!args?.slug || typeof args.slug !== "string") {
    throw new Error("slug is required");
  }
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: `/api/v1/chores/${encodeURIComponent(args.slug)}/source`,
  });
};

/**
 * GET /api/v1/chores/:slug/runs
 *
 * Paginated structured run history from chore-run-history.jsonl. Newer
 * + richer than the body-log scrape the detail page used in Phase 1 —
 * each entry has a real timestamp, dry-run flag, and age. Returns
 * { runs: [...], total }.
 */
export const getChoreRuns: GetChoreRuns<
  { slug: string; limit?: number; offset?: number },
  any
> = async (args, context) => {
  if (!args?.slug || typeof args.slug !== "string") {
    throw new Error("slug is required");
  }
  const instance = await getUserInstance(context);
  const q: Record<string, string> = {};
  if (typeof args.limit === "number") q.limit = String(args.limit);
  if (typeof args.offset === "number") q.offset = String(args.offset);
  return proxyToTenant(instance, {
    method: "GET",
    path: `/api/v1/chores/${encodeURIComponent(args.slug)}/runs`,
    query: q,
  });
};

/**
 * POST /api/v1/chores/:slug/pause
 *
 * Pauses the Temporal schedule and flips the vault record status to
 * "paused". The ctrl-api side is idempotent — calling pause on an
 * already-paused chore is a no-op.
 */
export const pauseChore: PauseChore<{ slug: string }, any> = async (
  args,
  context,
) => {
  if (!args?.slug || typeof args.slug !== "string") {
    throw new Error("slug is required");
  }
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/chores/${encodeURIComponent(args.slug)}/pause`,
  });
};

/**
 * POST /api/v1/chores/:slug/resume
 *
 * Unpauses the Temporal schedule and flips the vault record status
 * back to "active". Idempotent.
 */
export const resumeChore: ResumeChore<{ slug: string }, any> = async (
  args,
  context,
) => {
  if (!args?.slug || typeof args.slug !== "string") {
    throw new Error("slug is required");
  }
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/chores/${encodeURIComponent(args.slug)}/resume`,
  });
};

/**
 * DELETE /api/v1/chores/:slug
 *
 * Removes the Temporal schedule and marks the vault record completed.
 * The vault record itself is preserved (not deleted) so the user can
 * still see the run history. Best-effort: schedule deletion failures
 * don't prevent the vault status flip.
 */
export const deleteChore: DeleteChore<{ slug: string }, any> = async (
  args,
  context,
) => {
  if (!args?.slug || typeof args.slug !== "string") {
    throw new Error("slug is required");
  }
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "DELETE",
    path: `/api/v1/chores/${encodeURIComponent(args.slug)}`,
  });
};

/**
 * PATCH /api/v1/chores/:slug
 *
 * Patch a chore record's mutable fields. The Schedule editor on
 * /chores/:slug only ever patches the `schedule` field — but the
 * ctrl-api endpoint also accepts python_source / workflow_class_name /
 * params / name / user_facing_description / tags for future use.
 *
 * Schedule is a non-state field (chores aren't in the state-mutation
 * contract per spec §2 — they record their own runs via
 * record_chore_run); a plain PATCH is the right shape here.
 */
export const patchChore: any = async (
  args: {
    slug: string;
    schedule?: string;
    name?: string;
    user_facing_description?: string;
  },
  context: any,
) => {
  if (!args?.slug || typeof args.slug !== "string") {
    throw new Error("slug is required");
  }
  const instance = await getUserInstance(context);
  const body: Record<string, unknown> = {};
  if (typeof args.schedule === "string") body.schedule = args.schedule;
  if (typeof args.name === "string") body.name = args.name;
  if (typeof args.user_facing_description === "string") {
    body.user_facing_description = args.user_facing_description;
  }
  return proxyToTenant(instance, {
    method: "PATCH",
    path: `/api/v1/chores/${encodeURIComponent(args.slug)}`,
    body,
  });
};

/**
 * POST /api/v1/chores/:slug/trigger
 *
 * Manually fires the chore workflow once, outside its normal schedule.
 * Returns the workflow execution id so the caller can poll for status.
 *
 * This route may not exist on the ctrl-api yet — if it returns 404,
 * the UI should hide the Trigger button. (The route is added in this
 * PR if missing, see ctrl-api side.)
 */
export const triggerChore: TriggerChore<{ slug: string }, any> = async (
  args,
  context,
) => {
  if (!args?.slug || typeof args.slug !== "string") {
    throw new Error("slug is required");
  }
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/chores/${encodeURIComponent(args.slug)}/trigger`,
  });
};
