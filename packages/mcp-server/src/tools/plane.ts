// Plane MCP tool catalogue.
//
// Source of truth: packages/ctrl/src/api/routes/plane.ts (registered via
// registerPlaneRoutes() in src/api/server.ts).
//
// The ctrl-api Plane surface is deliberately small — it's a thin proxy in
// front of Plane's own REST. Sir reaches richer Plane data (lists of
// issues, projects, cycles) through the VAULT MIRROR (Plane → vault sync
// keeps tasks/matters as markdown) — those tools live under the Sure /
// other catalogues. The Plane MCP module specifically covers the four
// direct ctrl-api routes for read + comment + sync.
//
// The /api/v1/plane/webhook route is intentionally NOT exposed — it's an
// inbound HMAC-authenticated ingest from Plane → Alfred, not for the agent.

import { z } from "zod";
import type { ToolDef } from "./types.js";

const IssueParams = z.object({
  project_id: z.string().min(1).describe("The Plane project's id (UUID)"),
  issue_id: z.string().min(1).describe("The issue id (UUID) within that project"),
});

export const ALL_PLANE_TOOLS: ToolDef[] = [
  {
    name: "get_issue",
    description:
      "Fetch a single Plane issue by id. Returns id, name, description (HTML + stripped), state {id, name, group}, priority, labels, assignees, target_date, external_id, timestamps. Use when Sir asks 'what's the status of issue X?', 'who's assigned to ticket Y?', or before posting a comment so you have current assignees/state. Pre-req: you already know project_id + issue_id; if you only have a name, search the vault first (tasks are mirrored as markdown via Plane → vault sync). Backing: REST.",
    inputSchema: IssueParams,
    buildRequest: ({ project_id, issue_id }) => ({
      method: "GET",
      path: `/api/v1/plane/issues/${encodeURIComponent(project_id)}/${encodeURIComponent(issue_id)}`,
    }),
  },
  {
    name: "list_issue_comments",
    description:
      "Fetch the full comment thread on a Plane issue, oldest → newest. Each comment carries id, comment (HTML + stripped), actor, created_at, plus is_alfred (so you can identify your own past replies without an extra lookup). Use this when Sir asks 'what was discussed on issue X?', when you were spawned mid-thread by an @alfred mention, or before replying so you don't repeat yourself. Returns {comments: [...], total: number}. Backing: REST.",
    inputSchema: IssueParams,
    buildRequest: ({ project_id, issue_id }) => ({
      method: "GET",
      path: `/api/v1/plane/issues/${encodeURIComponent(project_id)}/${encodeURIComponent(issue_id)}/comments`,
    }),
  },
  {
    name: "post_issue_comment",
    description:
      "Post a comment on a Plane issue as Alfred. ctrl-api holds the Plane PAT — never bash-curl Plane directly. Returns {ok: true, comment_id}. Pass `text` for plain content (auto-escaped + wrapped in <p>) OR `text_html` for pre-rendered HTML formatting; at least one is required. NOT idempotent — posting twice creates two comments. If retrying after a network error, list_issue_comments first to check whether the comment already landed. Backing: REST.",
    inputSchema: z.object({
      project_id: z.string().min(1),
      issue_id: z.string().min(1),
      text: z.string().optional().describe("Plain text; auto-escaped and wrapped in <p>"),
      text_html: z.string().optional().describe("Pre-rendered HTML; passed through verbatim — sanitise yourself if it contains untrusted content"),
    }).refine(
      (v) => Boolean(v.text || v.text_html),
      { message: "Either `text` or `text_html` is required" },
    ),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/plane/comment",
      body: args,
    }),
  },
  {
    name: "trigger_plane_sync_nudge",
    description:
      "Kick off an immediate forward-sync of one vault record (a matter or a task) to Plane. Use when Sir has just edited a vault record and asks 'push that to Plane now', or to bypass the 15s cron. Most of the time this happens automatically on vault writes — only call directly for ad-hoc fixes. Fire-and-forget: returns 202 with {ok, scheduled, workflow_id?, reason?} once the Temporal workflow is dispatched. CRUCIAL: `record_type` + `slug` are the VAULT identifiers (e.g. record_type='matter', slug='client-x'), not Plane issue ids. Feature-gated by PLANE_SYNC_ENABLED — when off the response is {scheduled:false, reason:'PLANE_SYNC_ENABLED_off'} with HTTP 202, NOT an error. Backing: spawns Temporal PlaneSyncNudgeWorkflow on alfred-learn task queue.",
    inputSchema: z.object({
      record_type: z.enum(["matter", "task"]),
      slug: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/, "vault slug — alphanumeric/underscore/dash/dot, no slashes or leading dot"),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/plane/nudge",
      body: args,
    }),
  },
];
