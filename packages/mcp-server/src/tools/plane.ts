// Plane MCP tool catalogue.
//
// Source of truth: packages/ctrl/src/api/routes/plane.ts (registered via
// registerPlaneRoutes() in src/api/server.ts).
//
// v1 (4 tools, top of file): direct issue read + comment-thread + comment
// post + sync-nudge. Kept verbatim — they are the load-bearing flows.
//
// v2 (7 tools below): list / search / create / update issues, plus the
// resolution helpers (cycles, projects, states, labels). Together they
// give an agent enough surface to drive Plane without bouncing through
// the vault mirror, including a sophisticated search endpoint for
// cross-project queries (e.g. "blocked tickets across all projects").
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

  // ─── v2: list / search / create / update + resolution helpers ──────

  {
    name: "list_issues",
    description:
      "Simple paginated list of issues in ONE Plane project. Returns up to `limit` pruned issues (id, name, state, priority, labels, assignees, target_date, timestamps). Use when Sir asks 'what's open in project X?' and you already know the project_id (resolve via list_projects first if you only have a name). For cross-project queries, multi-dimension filters, state-group filters ('show me everything not done'), or 'blocked' tickets — use search_issues instead, this endpoint is intentionally narrow. Optional filters: state_id (see list_states), assignee_id, cycle_id (see list_cycles), order_by ('-updated_at' default, or '-created_at', '-priority'). Backing: REST.",
    inputSchema: z.object({
      project_id: z.string().min(1).describe("Plane project UUID (resolve via list_projects)"),
      state_id: z.string().optional().describe("Filter by single state UUID; resolve via list_states"),
      assignee_id: z.string().optional().describe("Filter by assignee UUID"),
      cycle_id: z.string().optional().describe("Filter by cycle UUID; resolve via list_cycles"),
      order_by: z.string().optional().describe("e.g. '-updated_at' (default), '-created_at', '-priority', 'target_date'"),
      limit: z.number().int().min(1).max(200).optional().describe("Page size; default 50, max 200"),
      offset: z.number().int().min(0).optional().describe("Pagination offset; default 0"),
    }),
    buildRequest: (args) => ({
      method: "GET",
      path: "/api/v1/plane/issues",
      query: args,
    }),
  },

  {
    name: "search_issues",
    description:
      "Sophisticated multi-dimensional issue search. THE power tool — use this for any non-trivial filter combination. All filter dimensions are optional and combine with AND semantics. Returns {issues: [...with project_id tagged on each], total, limit, offset, scope: {projects_searched, cross_project, is_blocked_via_label_match}}. Filter dimensions: project_ids (scope to N projects, omit for ALL workspace projects — capped at 15 for fan-out), cycle_ids, state_ids (UUIDs, exact), state_groups (friendly: 'backlog'|'unstarted'|'started'|'completed'|'cancelled' — resolved per-project to UUIDs server-side), assignee_ids, assigned_to_me (resolves to PLANE_ALFRED_USER_ID env), priority ('urgent'|'high'|'medium'|'low'|'none', multi-OR), label_ids, created_after/created_before/target_date_after/target_date_before/updated_after (ISO-8601), text_search (substring on name+description), is_blocked (LABEL-BASED — matches issues with a label literally named 'blocked'; for nuanced blocking semantics fetch label_ids via list_labels and pass them directly), order_by ('-updated_at' default), limit (default 50, max 200), offset. PRE-REQS: resolve UUIDs first via list_projects / list_states / list_labels — passing names won't work. CROSS-PROJECT LIMITATION: Plane's REST is project-scoped, so workspace-wide queries fan out (one upstream call per project) and merge client-side. Hard-capped at 15 projects; >15 projects in workspace returns 400 FANOUT_TOO_LARGE — pass project_ids explicitly. Backing: REST (multi-call fan-out for workspace-wide queries).",
    inputSchema: z.object({
      project_ids: z.array(z.string()).optional().describe("Scope to N project UUIDs; omit for all-workspace (capped at 15)"),
      cycle_ids: z.array(z.string()).optional(),
      state_ids: z.array(z.string()).optional().describe("Exact state UUIDs; takes precedence over state_groups"),
      state_groups: z.array(z.enum(["backlog", "unstarted", "started", "completed", "cancelled"])).optional().describe("Friendly group names; resolved per-project to state UUIDs"),
      assignee_ids: z.array(z.string()).optional(),
      assigned_to_me: z.boolean().optional().describe("Adds Alfred's PLANE_ALFRED_USER_ID to assignee_ids"),
      priority: z.array(z.enum(["urgent", "high", "medium", "low", "none"])).optional(),
      label_ids: z.array(z.string()).optional(),
      created_after: z.string().optional().describe("ISO-8601"),
      created_before: z.string().optional().describe("ISO-8601"),
      target_date_after: z.string().optional().describe("ISO-8601"),
      target_date_before: z.string().optional().describe("ISO-8601"),
      updated_after: z.string().optional().describe("ISO-8601"),
      text_search: z.string().optional().describe("Substring match on name+description"),
      is_blocked: z.boolean().optional().describe("true: only issues with label 'blocked'; false: exclude them. For nuanced blocking, use label_ids."),
      order_by: z.string().optional().describe("'-updated_at' default, or '-created_at', '-priority', 'target_date'"),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/plane/issues/search",
      body: args,
    }),
  },

  {
    name: "create_issue",
    description:
      "Create a new issue in a Plane project. Required: project_id + name. Optional: description_html (pre-rendered), state (UUID — resolve via list_states), priority ('urgent'|'high'|'medium'|'low'|'none'), assignees (array of user UUIDs), labels (array of label UUIDs — resolve via list_labels), target_date / start_date (ISO-8601), cycle (UUID — resolve via list_cycles), parent (issue UUID for sub-issues). Returns the pruned created issue {id, name, state, ...}. NOT idempotent — calling twice creates two issues. If retrying after a network error, search_issues with text_search to check whether the issue already landed. Backing: REST.",
    inputSchema: z.object({
      project_id: z.string().min(1),
      name: z.string().min(1),
      description_html: z.string().optional(),
      description_stripped: z.string().optional(),
      state: z.string().optional().describe("State UUID"),
      priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
      assignees: z.array(z.string()).optional().describe("Plane user UUIDs"),
      labels: z.array(z.string()).optional().describe("Label UUIDs"),
      target_date: z.string().optional().describe("ISO-8601 date"),
      start_date: z.string().optional().describe("ISO-8601 date"),
      parent: z.string().optional().describe("Parent issue UUID for sub-issues"),
      cycle: z.string().optional().describe("Cycle UUID"),
      external_id: z.string().optional(),
      external_source: z.string().optional(),
    }),
    buildRequest: ({ project_id, ...body }) => ({
      method: "POST",
      path: "/api/v1/plane/issues",
      body: { project_id, ...body },
    }),
  },

  {
    name: "update_issue",
    description:
      "Update an existing Plane issue. Use for state transitions ('move to Done'), reassignment, priority changes, label edits, target_date updates, name/description corrections. Body is a partial — only the fields you pass are written. Empty body is a no-op (Plane returns 200 with the unchanged record). Returns the pruned updated issue. PRE-REQS: state transitions need a state UUID — list_states first to map 'Done' → UUID. Same for labels (list_labels) and assignees. The `assignees`/`labels` arrays REPLACE the existing set — to add, fetch the current issue first via get_issue, append, then PATCH. Idempotent for non-array fields; array fields are replace-not-merge. Backing: REST.",
    inputSchema: z.object({
      project_id: z.string().min(1),
      issue_id: z.string().min(1),
      name: z.string().optional(),
      description_html: z.string().optional(),
      description_stripped: z.string().optional(),
      state: z.string().optional().describe("State UUID"),
      priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
      assignees: z.array(z.string()).optional().describe("REPLACES existing set"),
      labels: z.array(z.string()).optional().describe("REPLACES existing set"),
      target_date: z.string().optional().describe("ISO-8601 date"),
      start_date: z.string().optional().describe("ISO-8601 date"),
      parent: z.string().optional(),
      cycle: z.string().optional(),
    }),
    buildRequest: ({ project_id, issue_id, ...body }) => ({
      method: "PATCH",
      path: `/api/v1/plane/issues/${encodeURIComponent(project_id)}/${encodeURIComponent(issue_id)}`,
      body,
    }),
  },

  {
    name: "list_cycles",
    description:
      "List all cycles in a Plane project. Returns {cycles: [{id, name, description, start_date, end_date, status, project, total_issues, completed_issues}], total}. Use to resolve a cycle name ('Sprint 12') to a cycle_id for search_issues / create_issue / update_issue, or to surface 'what's the active cycle?' (status === 'CURRENT'). Cheap, idempotent. Backing: REST.",
    inputSchema: z.object({
      project_id: z.string().min(1),
    }),
    buildRequest: ({ project_id }) => ({
      method: "GET",
      path: "/api/v1/plane/cycles",
      query: { project_id },
    }),
  },

  {
    name: "list_projects",
    description:
      "List every project in the Plane workspace. Returns {projects: [{id, name, identifier, description, archived_at}], total}. ALWAYS your first call when Sir mentions a project by name ('what's open in Galerius?') — you need the UUID for every other Plane tool. archived_at is set on archived projects; usually filter those out. Cheap, idempotent. Backing: REST.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "GET",
      path: "/api/v1/plane/projects",
    }),
  },

  {
    name: "list_states",
    description:
      "List the workflow states for ONE project. Returns {states: [{id, name, group, color, project, default}], total}. State `group` is one of 'backlog'|'unstarted'|'started'|'completed'|'cancelled' — the cross-project taxonomy. Use to resolve a state name ('In Review' → UUID) before update_issue, or to discover the project's actual workflow shape (some projects have multiple states per group). Cheap, idempotent. Note: search_issues can take state_groups directly and resolves UUIDs server-side, so prefer that for filtering — call list_states only when you need a specific UUID. Backing: REST.",
    inputSchema: z.object({
      project_id: z.string().min(1),
    }),
    buildRequest: ({ project_id }) => ({
      method: "GET",
      path: "/api/v1/plane/states",
      query: { project_id },
    }),
  },

  {
    name: "list_labels",
    description:
      "List labels available in ONE project. Returns {labels: [{id, name, color, project}], total}. Use to resolve a label name ('blocked', 'p0', 'needs-design') to a UUID for search_issues label_ids / create_issue labels / update_issue labels. Note: search_issues `is_blocked: true` is a convenience for label.name === 'blocked' specifically — for other blocking-style labels (e.g. 'waiting-on-client') resolve here and pass label_ids. Cheap, idempotent. Backing: REST.",
    inputSchema: z.object({
      project_id: z.string().min(1),
    }),
    buildRequest: ({ project_id }) => ({
      method: "GET",
      path: "/api/v1/plane/labels",
      query: { project_id },
    }),
  },
];
