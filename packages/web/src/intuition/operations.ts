import type {
  GetIntuitionStatus,
  GetIntuitionInstincts,
  GetIntuitionQueue,
  GetObservations,
  GetRecentJudgments,
  GetSessions,
  RouteInput,
  EnableIntuition,
  DisableIntuition,
  UpdateInstinct,
  ResolveInstinctPromotion,
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";
import { deriveInstinctSlug, OBSERVATION_PATH } from "./instinctOpsCore";

export const getIntuitionStatus: GetIntuitionStatus<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { method: "GET", path: "/api/v1/learning/status" });
};

export const getIntuitionInstincts: GetIntuitionInstincts<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { method: "GET", path: "/api/v1/learning/instincts" });
};

export const getIntuitionQueue: GetIntuitionQueue<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { method: "GET", path: "/api/v1/learning/queue" });
};

export const routeInput: RouteInput<any, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { method: "POST", path: "/api/v1/learning/route", body: args });
};

export const enableIntuition: EnableIntuition<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { method: "POST", path: "/api/v1/learning/enable" });
};

export const disableIntuition: DisableIntuition<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { method: "POST", path: "/api/v1/learning/disable" });
};

export const getObservations: GetObservations<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  // Observations are a demoted type (§5.1) — they live in alfred-state.db,
  // not in vault/observation/. The vault directory is empty on live tenants.
  // Frozen contract (Lane I parallel): GET /api/v1/state/observations?instinct=<slug>&limit=20
  const data = await proxyToTenant(instance, {
    method: "GET",
    path: OBSERVATION_PATH,
    query: { limit: "20" },
  });
  // Normalise: add `results` alias so legacy callers (IntuitionPage) still
  // find their array at data.results while InstinctsPage reads data.observations.
  return { ...data, results: (data as any)?.observations ?? [] };
};

export const getRecentJudgments: GetRecentJudgments<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  // Same demoted-type fix as getObservations — state DB, not the empty vault dir.
  const data = await proxyToTenant(instance, {
    method: "GET",
    path: OBSERVATION_PATH,
    query: { limit: "20" },
  });
  return { ...data, results: (data as any)?.observations ?? [] };
};

export const getSessions: GetSessions<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/vault/list/session",
  });
};

export const updateInstinct: UpdateInstinct<{ path: string; set: { discretion_threshold?: number; status?: string } }, any> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PATCH",
    path: `/api/v1/vault/records/${args.path}`,
    body: { set: args.set },
  });
};

// Approve or decline a pending Acting promotion (#452 / #459).
// Lane I ctrl-api endpoint: POST /api/v1/learning/instincts/:slug/promotion
// Body: { approved: boolean }  Response: { tier, pending_promotion }
export const resolveInstinctPromotion: ResolveInstinctPromotion<
  { path: string; approved: boolean },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  // deriveInstinctSlug strips the directory prefix AND the trailing ".md" so
  // "instinct/close-stale-cards.md" → "close-stale-cards" rather than the
  // double-extension "close-stale-cards.md" that caused 404s (#459).
  const slug = deriveInstinctSlug(args.path);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/learning/instincts/${encodeURIComponent(slug)}/promotion`,
    body: { approved: args.approved },
  });
};
