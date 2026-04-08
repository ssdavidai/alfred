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
