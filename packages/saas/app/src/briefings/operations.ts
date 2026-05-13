/**
 * Briefings Wasp operations [STATE-MUTATION Phase E — #893].
 *
 * Wasp queries that proxy through to the ctrl-api briefing endpoints
 * shipped by the alfred-learn + ctrl-api side of Phase E. The composer
 * writes one `briefing/<YYYY-MM-DD>-<slot>.md` per slot per day; these
 * ops let the SaaS dashboard read both the list (for /briefings) and
 * the single record (for /brief and /briefings expand).
 *
 * All operations require an authenticated user and a running instance.
 * Errors propagate as HttpError so the dashboard can render them.
 *
 * Pattern mirrors `packages/saas/app/src/chores/operations.ts` (CHORE-P3).
 */
import type {
  GetBriefings,
  GetBriefing,
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";

/**
 * GET /api/v1/briefings
 *
 * Lists briefing records on the tenant. Each row is a summary
 * (frontmatter only, body stripped) so the index page can render
 * the chronological feed cheaply.
 *
 * Query params (all optional):
 *   slot    "morning" | "evening" | "all" (default "all")
 *   since   ISO timestamp filter on composed_at (>=)
 *   until   ISO timestamp filter on composed_at (<=)
 *   limit   default 30, capped at 100 on the ctrl-api side
 *
 * Returns `{ briefings: BriefingListItem[], total: number }`.
 */
export const getBriefings: GetBriefings<
  { slot?: string; since?: string; until?: string; limit?: number },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  const q: Record<string, string> = {};
  if (args?.slot && typeof args.slot === "string") q.slot = args.slot;
  if (args?.since && typeof args.since === "string") q.since = args.since;
  if (args?.until && typeof args.until === "string") q.until = args.until;
  if (typeof args?.limit === "number") q.limit = String(args.limit);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/briefings",
    query: q,
  });
};

/**
 * GET /api/v1/briefings/:slugDate
 *
 * Single briefing record — frontmatter + full body so the page can
 * render the letterpress prose. The slug-date shape is
 * `<YYYY-MM-DD>-<slot>` (e.g. `2026-05-13-morning`).
 */
export const getBriefing: GetBriefing<{ slugDate: string }, any> = async (
  args,
  context,
) => {
  if (!args?.slugDate || typeof args.slugDate !== "string") {
    throw new Error("slugDate is required");
  }
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: `/api/v1/briefings/${encodeURIComponent(args.slugDate)}`,
  });
};
