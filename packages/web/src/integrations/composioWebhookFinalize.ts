/**
 * Composio webhook → ComposioConnection status flip (internal endpoint).
 *
 * What this is
 * ------------
 * The Wasp `api` `finalizeComposioWebhook` (POST /webhook/composio/finalize)
 * is the web-side landing for ctrl-api's Composio webhook handler. ctrl-api
 * receives + HMAC-validates Composio's `connected_account.updated → ACTIVE`
 * webhook, then POSTs `{connectionId, status}` here so the row can flip on
 * the SaaS DB.
 *
 * See packages/ctrl/src/api/routes/composioWebhook.ts for the inbound side
 * and the joe-incident rationale.
 *
 * Auth
 * ----
 * Shared secret `AAS_API_KEY` — the same secret used in the other direction
 * (web → ctrl-api). It arrives in the `X-AAS-API-Key` header (NOT the
 * standard `Authorization: Bearer ...`). Reason: Wasp's per-route `auth`
 * middleware runs BEFORE the api fn's own middlewareConfigFn and tries to
 * validate any Bearer token as a user session token — a service-side key
 * gets rejected with `{"message":"Invalid credentials"}` before our
 * handler ever runs. Using a custom header sidesteps that gate cleanly.
 * (The `userApiProxy` pattern works only because its `alf_*` keys never
 * pass through the auth gate — Wasp's middleware lets requests with NO
 * Authorization header fall through to the handler.) The middleware
 * deletion is kept as a defence-in-depth no-op.
 *
 * The endpoint is NOT user-facing; it's compose-network-only and never
 * crosses the Caddy public surface.
 *
 * Why this isn't an action
 * ------------------------
 * Wasp actions require an authenticated user (`context.user`). This endpoint
 * is service-to-service — there is no user session. Hence the `api`
 * declaration with custom middleware, mirroring how `userApiProxy` handles
 * its own bearer-token auth.
 *
 * Idempotency
 * -----------
 * A second call for an already-ACTIVE row returns 200 with `noop: true` and
 * does NOT touch `updatedAt`. We do NOT touch `autoConfigState` — the
 * existing reconcileComposioAutoConfigJob picks that up within 60 seconds
 * once it sees status="ACTIVE".
 *
 * Unknown connectionId
 * --------------------
 * Composio may fire `connected_account.updated` events for a connection the
 * user deleted on our side. Return 200 with `noop: "not found"` so neither
 * Composio nor ctrl-api treats it as a retryable failure.
 */

import type { MiddlewareConfigFn } from "wasp/server";
import { markStatusActive } from "./connectionRepo";

// Wasp generates a typed FinalizeComposioWebhook<...> from main.wasp, but
// since this file ships in the same commit as the api declaration, the
// generated type is not available at editor-time on the first build. We
// fall back to the loose `(req, res, context) => Promise<void>` shape that
// every other Wasp api fn uses (see apikeys/proxy.ts:userApiProxy for the
// canonical pattern).

const AAS_API_KEY = process.env.AAS_API_KEY ?? "";

// ── middleware ─────────────────────────────────────────────────────────────
//
// Same pattern as apikeys/proxy.ts:apiProxyMiddleware — strip Wasp's default
// authMiddleware so we can do our own service-token check here.

export const finalizeComposioWebhookMiddleware: MiddlewareConfigFn = (
  middlewareConfig,
) => {
  middlewareConfig.delete("authMiddleware");
  return middlewareConfig;
};

// ── handler ────────────────────────────────────────────────────────────────

interface FinalizePayload {
  connectionId: string;
  status?: string;
}

function parsePayload(raw: unknown): FinalizePayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.connectionId !== "string" || b.connectionId.length === 0) {
    return null;
  }
  return {
    connectionId: b.connectionId,
    status: typeof b.status === "string" ? b.status : "ACTIVE",
  };
}

export const finalizeComposioWebhook = async (
  req: any,
  res: any,
  context: any,
): Promise<void> => {
  // Service-token auth. The middleware above has already stripped Wasp's
  // user-session check, so this is the only gate.
  if (!AAS_API_KEY) {
    console.error(
      "[finalizeComposioWebhook] AAS_API_KEY is not set on the web container — refusing",
    );
    res.status(500).json({
      error: { code: "NOT_CONFIGURED", message: "AAS_API_KEY is not set" },
    });
    return;
  }
  // Service-token comes in on a custom header — see the file-header
  // comment for why this isn't `Authorization: Bearer ...`. Both lower-
  // and original-case lookups since express's req.headers is lower-cased
  // but some test harnesses preserve the original casing.
  const headerValue =
    (req.headers["x-aas-api-key"] as string | undefined) ??
    (req.headers["X-AAS-API-Key"] as string | undefined) ??
    "";
  if (!headerValue || headerValue !== AAS_API_KEY) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "X-AAS-API-Key header required" },
    });
    return;
  }

  const payload = parsePayload(req.body);
  if (!payload) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Body must be { connectionId: string, status?: string }",
      },
    });
    return;
  }

  const targetStatus = (payload.status ?? "ACTIVE").toUpperCase();
  if (targetStatus !== "ACTIVE") {
    // Defensive — this endpoint only handles the INITIATED → ACTIVE flip
    // today. Other lifecycle events (FAILED, deletion, …) are scoped out of
    // this PR. Refuse loudly so a future caller doesn't accidentally write
    // a different status here.
    res.status(400).json({
      error: {
        code: "UNSUPPORTED_STATUS",
        message: `finalize endpoint only sets status=ACTIVE (got ${payload.status})`,
      },
    });
    return;
  }

  const delegate = context.entities.ComposioConnection;
  const existing = await delegate.findUnique({
    where: { connectionId: payload.connectionId },
  });
  if (!existing) {
    // Composio fired an event for a connection that no longer exists on our
    // side. 200 — don't trigger ctrl-api / Composio retries.
    console.info(
      `[finalizeComposioWebhook] no row for connectionId=${payload.connectionId} — noop`,
    );
    res.status(200).json({ ok: true, noop: "not found" });
    return;
  }

  if (existing.status === "ACTIVE") {
    // Idempotent — already in the target state. Skip the update so we don't
    // churn updatedAt on every Composio retry.
    res.status(200).json({
      ok: true,
      noop: true,
      connectionId: payload.connectionId,
      status: "ACTIVE",
    });
    return;
  }

  // Use the shared markStatusActive helper introduced in #72 (the reconciler
  // INITIATED-row widening PR) — same code path the safety-net reconciler
  // takes, so the webhook fast-path and the polling slow-path produce
  // byte-identical row state. The helper only writes `status` +
  // `lastSyncedAt`; `autoConfigState` stays untouched and the existing
  // 1-min reconciler drives auto-config from there.
  await markStatusActive(delegate, existing.userId, payload.connectionId);
  console.info(
    `[finalizeComposioWebhook] flipped ${existing.toolkit}/${payload.connectionId} ` +
      `${existing.status} → ACTIVE (reconciler will pick up within 60s)`,
  );

  res.status(200).json({
    ok: true,
    connectionId: payload.connectionId,
    previous_status: existing.status,
    status: "ACTIVE",
  });
};
