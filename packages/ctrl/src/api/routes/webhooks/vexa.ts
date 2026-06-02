// Vexa retirement (#113 PR1) — 410 Gone stub.
//
// The Vexa transcript-bot stack was deleted in PR #113 PR1 (see
// docs/specs/issue-113-vexa-to-recall.md). This webhook endpoint is
// kept as a thin 410 Gone responder for one release so any in-flight
// Vexa retries (their delivery envelope is generous) terminate visibly
// rather than 404'ing through Caddy's SPA fall-through.
//
// Remove this stub in the PR that lands Recall.ai (#113 PR2).
//
// Surface stubbed:
//   POST /api/v1/webhooks/vexa  → 410
import { addRoute } from "../../server.js";
import { sendJson } from "../../errors.js";

const GONE_BODY = {
  deprecated: true,
  replacement: "recall.ai is coming — see issue #113",
} as const;

export function registerVexaWebhookRoute(): void {
  addRoute("POST", "/api/v1/webhooks/vexa", async ({ res }) => {
    sendJson(res, 410, GONE_BODY);
  });
}
