// Vexa retirement (#113 PR1) — 410 Gone stub.
//
// The Vexa transcript-bot stack was deleted in PR #113 PR1 (see
// docs/specs/issue-113-vexa-to-recall.md). This file is intentionally
// kept as a thin 410 Gone responder for one release so any forgotten
// caller (a stale SaaS client, an MCP integration that cached the old
// path, a dashboard tab the principal hasn't reloaded) sees a clear
// migration signal rather than a 404.
//
// Remove this stub in the PR that lands Recall.ai (#113 PR2 / PR3a).
//
// Surfaces stubbed:
//   GET  /api/v1/admin/vexa/auto-join  → 410
//   POST /api/v1/admin/vexa/auto-join  → 410
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";

const GONE_BODY = {
  deprecated: true,
  replacement: "recall.ai is coming — see issue #113",
} as const;

export function registerVexaRoutes(): void {
  addRoute("GET", "/api/v1/admin/vexa/auto-join", async ({ res }) => {
    sendJson(res, 410, GONE_BODY);
  });
  addRoute("POST", "/api/v1/admin/vexa/auto-join", async ({ res }) => {
    sendJson(res, 410, GONE_BODY);
  });
}
