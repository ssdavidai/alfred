// Alfred MCP tool catalogue.
//
// One TS object per /api/v1/* endpoint surfaced through the tenant ctrl-api
// that we're willing to expose over a 1-hour bearer token bound to a remote
// LLM (claude.ai's Custom Connectors). Source of truth: routes under
// packages/ctrl/src/api/routes/{vault,agents,admin,openclaw,workflows,devices}.ts.
// Descriptions are written for the model on the other end of the connector —
// what to call, when to call it, what to chain it with, what NOT to do.
//
// Conventions (mirror sure.ts / plane.ts):
//   - tool names are snake_case
//   - path params are URL-encoded by buildUrl()
//   - .strict() is intentionally NOT used — extra fields are forwarded so
//     ctrl-api additions work without an MCP redeploy
//   - "Backing: <thing>" surfaces what actually runs (filesystem read, docker
//     exec into the alfred CLI, openclaw cron job, temporal CLI, …)
//
// Deliberately NOT included (deferred — too dangerous for a remote LLM with a
// 1h bearer token to call unattended):
//   - workers up/down/restart                  → can hard-stop alfred services
//   - admin/containers/* restart|stop|start    → can break the box mid-call
//   - admin/chores/emergency-pause-all         → fleet-wide chore halt
//   - credentials PATCH (rotate)               → rotates secrets out of sync
//   - admin/config/env PATCH                   → can brick boot
//   - pairing revoke|clear-pending             → can lock Sir's channels out
//   - openclaw/restart                         → kills the running session
//   - logs streaming                           → bandwidth + leak surface
// These remain available to in-tenant agents (Alfred main, chores) where
// scoped trust is much higher; they're just not exposed over the connector.

import { z } from "zod";
import type { ToolDef } from "./types.js";

// ─── shared schema fragments ────────────────────────────────────────────────

// Vault paths arrive as `<type>/<slug>.md` with no leading slash. The ctrl-api
// route mounts as `/api/v1/vault/records/*` and resolveVaultPath rejects
// traversal, so we keep the schema permissive (any non-empty string) and let
// the backend reject malformed paths with a 400.
const VaultRelPath = z.string().min(1).describe(
  "Vault-relative path, e.g. matter/acme.md or task/follow-up-sam.md (no leading slash)",
);

// ─── vault ──────────────────────────────────────────────────────────────────

const vaultTools: ToolDef[] = [
  {
    name: "list_vault_by_type",
    description:
      "List every record of a given vault type (matter, task, note, person, org, place, asset, chore, instinct, briefing, daybook, decision, …). Returns one entry per record with `path` (vault-relative, suitable for get_vault_record / update_vault_record), `name`, `status`, full `frontmatter`, a truncated `body_preview` (default 500 chars, max 2000 via `preview` query), and `created`. Use this when Sir asks 'what matters am I working on?', 'what tasks are open?', or before creating a record so you don't duplicate an existing one. Cheap, idempotent, no pagination — the list is bounded by what the type directory holds. Backing: filesystem walk of /vault/<type>/.",
    inputSchema: z.object({
      type: z.string().min(1).describe(
        "One of: matter, task, note, person, org, place, asset, chore, instinct, briefing, daybook, decision (the 12 canonical types). Legacy/derived directories (event, observation, reflection, triage, …) may also still resolve. Unknown types return 400.",
      ),
      preview: z.number().int().min(0).max(2000).optional().describe(
        "Body-preview character count; 0 to omit, max 2000. Default 500.",
      ),
    }),
    buildRequest: ({ type, preview }) => ({
      method: "GET",
      path: `/api/v1/vault/list/${encodeURIComponent(type)}`,
      query: preview !== undefined ? { preview } : undefined,
    }),
  },
  {
    name: "search_vault",
    description:
      "Free-text and/or glob search across the entire vault. Pass `grep` for a case-insensitive substring match against the raw file content (frontmatter + body), `glob` for a path pattern (e.g. `matter/*` or `**/acme*`), or both to AND them. **The route REQUIRES at least one of `grep` or `glob`** — calling without either throws 400 (refuses to walk the whole vault). DO NOT use `q` or any other param name; the route ignores unrecognised params and would otherwise return everything, blowing the MCP transport size cap. Returns `{results, count, truncated}` — each result is `{path, name, type, status}`. Capped at 100 results by default (max 500 via `limit`); when `truncated: true`, narrow the search rather than asking for more. Use when Sir says 'what do we have on Acme?' or 'find anything mentioning Sam Park' and you don't yet know the record's path. Backing: filesystem walk + substring scan (no index — keep `grep` reasonably specific on large vaults).",
    inputSchema: z.object({
      grep: z.string().optional().describe(
        "Case-insensitive substring matched against raw file content. Use multi-word phrases or distinctive terms — single common words match thousands of records.",
      ),
      glob: z.string().optional().describe(
        "Path glob (relative to vault root). `*` matches a single segment, `**` matches across segments. No leading slash, no `..` traversal.",
      ),
      limit: z.number().int().min(1).max(500).optional().describe(
        "Cap on results (default 100, max 500). Bound to keep responses under claude.ai's MCP transport size limit.",
      ),
    }).refine(
      (v) => Boolean(v.grep || v.glob),
      { message: "At least one of `grep` or `glob` is required" },
    ),
    buildRequest: (args) => ({
      method: "GET",
      path: "/api/v1/vault/search",
      query: args,
    }),
  },
  {
    name: "get_vault_record",
    description:
      "Read one vault record by its EXACT vault-relative path. Returns `{path, frontmatter, body}` — the full Markdown body and the parsed YAML frontmatter as a JSON object. The path can be passed with or without a `.md` suffix; the backend appends `.md` automatically if needed. **DON'T GUESS PATHS.** Always derive the path from a prior `search_vault` or `list_vault_by_type` result — a hallucinated 'matter/acme.md' returns 404 and looks like a tool failure to Sir. ALWAYS call this before update_vault_record so you can read current frontmatter (status, owner, tags, related[]) and craft a minimal patch that doesn't clobber other fields. 404 means the record doesn't exist at the path you passed — re-search rather than retrying with a tweaked path. Backing: filesystem read + js-yaml frontmatter parse.",
    inputSchema: z.object({
      path: VaultRelPath,
    }),
    buildRequest: ({ path }) => ({
      method: "GET",
      // The route is `/api/v1/vault/records/*` — pass the full relative path
      // through verbatim. encodeURIComponent would mangle the slashes.
      path: `/api/v1/vault/records/${path}`,
    }),
  },
  {
    name: "create_vault_record",
    description:
      "Create a new vault record. `type` MUST be one of the 12 canonical vault types — matter, task, note, person, org, place, asset, chore, instinct, briefing, daybook, decision. Anything else (observation, reflection, project, event, …) is rejected by ctrl-api with a 422; those classes are NOT principal-facing vault records (observations/audit live in state.db, not the vault). Two modes: (1) high-level, pass `type` + `name` + optional `fields` to let the alfred CLI scaffold the file with default frontmatter (`type`, `name`, `created`, `status`, …); or (2) raw, pass `type` + `name` + `content` where `content` is the entire file body INCLUDING frontmatter — used when you already have a fully-formed record (typical when migrating or transcribing). Returns 201 with the new record's path. Side effects: matter/* and task/* records mirror to Plane via the 15s forward-sync cron. Pre-reqs: search_vault first to avoid duplicates; check the vault schema if unsure which fields a type needs (every record needs `type`, `name`, `created`; tasks additionally need `owner: alfred|human`). Backing: docker exec alfred CLI for mode 1, direct fs.writeFile for mode 2.",
    inputSchema: z.object({
      type: z.enum([
        "matter", "task", "note", "person", "org", "place", "asset",
        "chore", "instinct", "briefing", "daybook", "decision",
      ]).describe(
        "Record type — one of the 12 canonical vault types: matter, task, note, person, org, place, asset, chore, instinct, briefing, daybook, decision. Non-canonical types (observation, reflection, project, event) are 422'd by ctrl-api.",
      ),
      name: z.string().min(1).describe(
        "Slug or filename. May include the `.md` extension or a `<type>/` prefix; backend normalises both. Use lowercase-with-dashes.",
      ),
      content: z.string().optional().describe(
        "Mode 2 — full file content including the leading `---\\ntype: …\\n---\\n` frontmatter block. When set, `fields` is ignored.",
      ),
      fields: z.record(z.string(), z.string()).optional().describe(
        "Mode 1 — extra frontmatter fields to set on the scaffolded record. Each value is forwarded as `--set k=v` to the alfred CLI.",
      ),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/vault/records",
      body: args,
    }),
  },
  {
    name: "update_vault_record",
    description:
      "Patch an existing vault record. Three orthogonal operations, all optional and all applied to the same record under a per-path mutex: `set` rewrites frontmatter scalars (e.g. `{status: 'done'}`), `append` extends frontmatter list fields (e.g. `{tags: 'urgent'}` adds 'urgent' to the existing `tags:` array), `body_append` concatenates a Markdown blob onto the body, `body_set` REPLACES the entire body wholesale (frontmatter preserved). Always get_vault_record FIRST so you patch deltas, not the whole record. Idempotent for `set` (re-applying the same value is a no-op); NOT idempotent for `append` / `body_append` — re-running duplicates entries / appends. matter/* and task/* writes trigger Plane sync. Returns 200 + the CLI's parsed JSON response. Backing: docker exec alfred CLI under per-path lock.",
    inputSchema: z.object({
      path: VaultRelPath,
      set: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe(
        "Frontmatter scalar overrides. Each entry becomes `--set key=value`. Quote-aware — pass `false` (boolean) not `'false'` (string).",
      ),
      append: z.record(z.string(), z.string()).optional().describe(
        "Append values to frontmatter list fields (`tags`, `related`, `participants`, `depends_on`, …). Each entry becomes `--append key=value`. NOT idempotent.",
      ),
      body_append: z.string().optional().describe(
        "Markdown text to concatenate onto the end of the body. NOT idempotent.",
      ),
      body_set: z.string().optional().describe(
        "Replace the body wholesale, preserving frontmatter. Use sparingly — typically only to clear stub bodies before plane_sync renders them as descriptions.",
      ),
    }),
    buildRequest: ({ path, ...body }) => ({
      method: "PATCH",
      path: `/api/v1/vault/records/${path}`,
      body,
    }),
  },
  {
    name: "promote_triage_to_task",
    description:
      "Convert a triage/* record into a task/* record (an 'errand') and mark the triage as resolved. Use when Sir reviews his triage queue and says 'turn that into a task' or 'add it as an errand for me'. The new task inherits the triage's name + body, gets `status: queued`, and back-links to the source triage via `source_triage:`. Returns 201 with `{taskPath, triagePath, name, status: 'promoted'}`. Pass `owner: 'human'` (default) for things Sir himself will action, `owner: 'alfred'` for work Alfred should pick up. Optional `matter` (slug only, no `[[…]]`) wikilinks the new task into a standing matter. Pre-req: search_vault for type=triage first to find the right triagePath. Backing: file create + docker exec alfred CLI for the resolved-flag flip.",
    inputSchema: z.object({
      triagePath: z.string().min(1).describe(
        "Vault-relative path to the triage record, e.g. `triage/2026-05-03-some-thing.md`.",
      ),
      matter: z.string().optional().describe(
        "Optional matter slug (no `matter/` prefix, no `.md`, no `[[…]]`). The created task's frontmatter gets `matter: \"[[matter/<slug>]]\"`.",
      ),
      owner: z.enum(["human", "alfred"]).optional().describe(
        "Defaults to 'human'. Set 'alfred' when Sir handed the work to Alfred (e.g. 'draft the reply for me').",
      ),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe(
        "Defaults to 'normal'.",
      ),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/vault/promote-triage",
      body: args,
    }),
  },
];

// ─── agents ─────────────────────────────────────────────────────────────────

const agentTools: ToolDef[] = [
  {
    name: "spawn_alfred_task",
    description:
      "Hand a one-shot task to Sir's main Alfred agent. Use this when Sir asks claude.ai to 'tell Alfred to …' or when you want Alfred to DO something (run a skill, post a briefing, perform a workflow) rather than just compute it here. Under the hood: creates an openclaw cron job with `--at 1s --delete-after-run`, the job fires immediately, runs in an isolated main-agent session with Sir's full skill set + memory, then self-destroys. Returns 202 `{status: 'scheduled', name, channel, at_seconds, job}`. DELIVERY IS OPT-IN: by default the run is silent and Sir is NOT messaged — pass `announce: true` only when Sir asked for the result on a channel (#288: background callers relying on the old announce-by-default filled his Slack with worker failure dumps). Set `channel` to override 'last'. NOT idempotent — calling twice schedules two runs. Backing: docker exec openclaw cron add (the same path the in-CLI scheduler uses).",
    inputSchema: z.object({
      task: z.string().min(1).describe(
        "The prompt Alfred sees. Be explicit — Alfred won't see context from claude.ai. Include any skill names, vault paths, or recipients he needs.",
      ),
      channel: z.string().optional().describe(
        "Delivery channel. 'last' (default) = the most-recent active channel; 'slack' / 'telegram' / 'email' / 'sms' force a specific one.",
      ),
      to: z.string().optional().describe(
        "Explicit delivery target (e.g. a Slack thread URL or Telegram chat id). Usually leave unset — backend resolves from session state.",
      ),
      at_seconds: z.number().int().min(1).optional().describe(
        "Seconds-from-now until the job fires. Default 1 (≈ immediate).",
      ),
      name: z.string().optional().describe(
        "Cron job name; default `agent-task-<ts>-<rand>`. Override only when Sir wants the run identifiable in `openclaw cron list` output.",
      ),
      announce: z.boolean().optional().describe(
        "Channel delivery. Default FALSE — the run happens but Sir is NOT messaged. Pass true ONLY when Sir has asked for the result to reach him on a channel (e.g. 'tell Alfred to post the briefing to Slack'). Never pass true from background/maintenance work: that is how vault-worker failure dumps ended up in Sir's Slack (#288).",
      ),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/agents/main/task",
      body: args,
    }),
  },
  {
    name: "list_agents",
    description:
      "List the OpenClaw agents available on this tenant (main = Alfred, learn-clerk = stateless LLM worker for the learning pipeline, vault-curator = inbox processor, vault-janitor = structural fixer, vault-distiller = latent-knowledge extractor) plus surveyor configuration (labeler/embedder models). Returns `{agents: [{id, label, description}], surveyor}`. Use this to confirm which agent ids exist before reasoning about delegation, or when Sir asks 'who's running on my box?'. Read-only, cheap, idempotent. Note: spawn_alfred_task always targets the main agent — list_agents is reference, not a router. Backing: filesystem read of config.yaml.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "GET", path: "/api/v1/admin/agents" }),
  },
];

// ─── workflows (Temporal) ───────────────────────────────────────────────────

const workflowTools: ToolDef[] = [
  {
    name: "list_workflows",
    description:
      "List Temporal workflow executions (running + recently closed) on the tenant's Temporal server. Optional `query` is a Temporal visibility query string — e.g. `WorkflowType=\"OnboardingPipelineWorkflow\"`, `ExecutionStatus=\"Running\"`, `StartTime > '2026-05-01T00:00:00Z'`. Returns one JSON object per execution with workflow_id, run_id, type, status, start_time, etc. Use when Sir asks 'is anything running?', 'did the morning briefing fire?', or before describe_workflow when you need the workflow_id. Bounded result set — Temporal applies its own pagination cap. Backing: docker exec into temporal container, `temporal workflow list --output json`.",
    inputSchema: z.object({
      query: z.string().optional().describe(
        "Temporal visibility query (SQL-ish). Omit to list everything recent. Examples: `WorkflowType=\"BriefingWorkflow\"`, `ExecutionStatus=\"Failed\"`.",
      ),
    }),
    buildRequest: ({ query }) => ({
      method: "GET",
      path: "/api/v1/workflows",
      query: query ? { query } : undefined,
    }),
  },
  {
    name: "describe_workflow",
    description:
      "Fetch the full execution detail for one Temporal workflow: status, start/close times, search attributes, last failure (if any), pending activities. Use when Sir asks 'why did the digest fail?' or to confirm a workflow you just started_workflow actually launched. Pass `run_id` only when you need a specific historical run; omitting it returns the most recent run for that workflow_id. Backing: temporal workflow describe. Cheap, read-only.",
    inputSchema: z.object({
      wfId: z.string().min(1).describe("Temporal workflow_id, e.g. `onboarding-david-1714765432`."),
      run_id: z.string().optional().describe("Specific run id; omit for latest run."),
    }),
    buildRequest: ({ wfId, run_id }) => ({
      method: "GET",
      path: `/api/v1/workflows/${encodeURIComponent(wfId)}`,
      query: run_id ? { run_id } : undefined,
    }),
  },
  {
    name: "start_workflow",
    description:
      "Start a new Temporal workflow execution. `workflow_type` is the registered class name (e.g. `OnboardingPipelineWorkflow`, `BriefingWorkflow`, `TaskRunnerWorkflow`); `task_queue` is usually `alfred-learn` for learn-package workflows. Pass `input` as the JSON-serialisable arg the workflow expects (a single positional arg — wrap multi-arg shapes in an object). `BriefingWorkflow` takes a positional `slot` string (`\"morning\"` or `\"evening\"`). Optional `workflow_id` for caller-supplied id; otherwise Temporal generates one. Returns 201 with `workflow_id` + `run_id`. NOT idempotent unless you pass a stable `workflow_id` and use Temporal's reuse-policy semantics on the worker side. Use describe_workflow afterwards to confirm it landed. Pre-req: list the available workflow types in the codebase or ask Sir; spawning an unknown type returns a Temporal error. Backing: temporal workflow start.",
    inputSchema: z.object({
      workflow_type: z.string().min(1).describe(
        "Registered workflow class name. Common ones on alfred-learn: OnboardingPipelineWorkflow, BriefingWorkflow, EventProcessorWorkflow, ReflectionWorkflow, JudgmentWorkflow, TaskRunnerWorkflow. (`DailyDigestWorkflow`, `DailyMorningBriefingWorkflow`, and `DailyEveningDigestWorkflow` were deleted in commit f20556d and folded into `BriefingWorkflow`.)",
      ),
      task_queue: z.string().min(1).describe(
        "Worker task queue. `alfred-learn` for learn-package workflows; `plane-sync` for plane mirror workflows.",
      ),
      input: z.unknown().optional().describe(
        "Single positional arg for the workflow. Object/array/scalar — JSON-serialised verbatim.",
      ),
      workflow_id: z.string().optional().describe(
        "Caller-supplied workflow id. Omit for an auto-generated UUID-suffixed id.",
      ),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/workflows",
      body: args,
    }),
  },
  {
    name: "signal_workflow",
    description:
      "Send a Temporal signal to a running workflow. Use when a long-running workflow is awaiting input (e.g. onboarding's awaiting_verification step expects a `corrections_received` signal). `signal_name` MUST match a `@workflow.signal`-decorated method name on the workflow class. `input` is the payload the signal handler receives (single positional arg, like start_workflow). Returns 200 `{message: 'Signal sent'}`. Idempotent only if the signal handler is — most are not (each call moves state). Pre-req: describe_workflow to confirm the workflow is still running and to read its expected signals. Backing: temporal workflow signal.",
    inputSchema: z.object({
      wfId: z.string().min(1),
      signal_name: z.string().min(1).describe(
        "The @workflow.signal method name. Examples: `corrections_received`, `pause`, `cancel_request`.",
      ),
      input: z.unknown().optional().describe(
        "Signal payload (single positional arg). Omit for signals that take no args.",
      ),
      run_id: z.string().optional().describe("Specific run id; omit to signal the latest run."),
    }),
    buildRequest: ({ wfId, ...body }) => ({
      method: "POST",
      path: `/api/v1/workflows/${encodeURIComponent(wfId)}/signal`,
      body,
    }),
  },
];

// ─── openclaw diagnostics (read-only) ───────────────────────────────────────

const openclawTools: ToolDef[] = [
  {
    name: "get_openclaw_health",
    description:
      "Health check on the OpenClaw gateway (the LLM/MCP router on :18789 every Alfred call goes through). Returns the gateway's own JSON health envelope — provider auth status, queue depth, cron tick latency, MCP server availability. Use when Sir asks 'is Alfred up?', when spawn_alfred_task returns errors, or as a quick sanity probe before kicking off a workflow. Cheap and idempotent. Read-only — does NOT restart anything (we deliberately don't expose openclaw/restart over this connector). Backing: docker exec openclaw gateway health.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "GET", path: "/api/v1/openclaw/health" }),
  },
  {
    name: "list_openclaw_agents",
    description:
      "List the OpenClaw agents AS THE GATEWAY SEES THEM (model bindings, provider auth, fallback chain) — distinct from list_agents which reads the static config catalogue. Use for diagnosing 'why did Alfred answer with a stub?' or 'which model is the curator using right now?'. Read-only, idempotent, cheap. Backing: docker exec openclaw agents.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "GET", path: "/api/v1/openclaw/agents" }),
  },
  {
    name: "list_openclaw_allowed_tools",
    description:
      "Return the gateway's tool inventory: `builtin_tools[]` (sessions_*, web_search, web_fetch, composio_execute and similar core gateway tools registered in `gateway.tools.allow`) and `mcp_tools[]` (tools exposed by configured MCP servers — alfred-ctrl/self, plus tenant/ask_alfred when ALFRED_PRIME=true). Use when Sir asks 'what can Alfred do?' or before drafting a spawn_alfred_task that depends on a particular tool being enabled. Composio per-app actions are NOT in this response — they're listed separately by the SaaS Tools page. Read-only, cheap, idempotent. Backing: filesystem read of openclaw.json.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "GET", path: "/api/v1/openclaw/allowed-tools" }),
  },
];

// ─── DM pairing (approve only) ──────────────────────────────────────────────

const deviceTools: ToolDef[] = [
  {
    name: "approve_device",
    description:
      "Approve a pending Hermes DM-pairing code — what happens after an unknown messaging account (Telegram, Slack, …) DMs Alfred's gateway and is handed a one-hour pairing code that needs the operator's nod before that conversation can reach Alfred. Pass the `platform` and the 8-char `code`; the principal's dashboard `/dashboard/devices` page shows pending codes (it surfaces the raw `hermes pairing list` text). Returns 200 with the Hermes CLI's confirmation message. NOT exposed over this connector (deliberately): revoke / clear-pending — those can lock Sir's channels out and shouldn't be driven by a remote LLM with a 1h bearer. Use this ONLY when Sir explicitly asks claude.ai to approve a pending pairing while he's away from his phone. Backing: docker exec hermes pairing approve <platform> <code>.",
    inputSchema: z.object({
      platform: z.string().min(1).describe(
        "Messaging platform the pairing code is for — e.g. telegram, slack, discord, whatsapp, signal.",
      ),
      code: z.string().min(1).describe(
        "The 8-character pairing code (unambiguous alphabet, no 0/O/1/I). Sir's `/dashboard/devices` page shows pending codes; `hermes pairing list` is the underlying source.",
      ),
    }),
    buildRequest: ({ platform, code }) => ({
      method: "POST",
      path: `/api/v1/devices/approve`,
      body: { platform, code },
    }),
  },
];

// ─── briefings / decisions / state-changes / pending / in-flight ────────────
//
// The Desk-and-delegation surface: every reader an exec subagent (or a
// remote LLM via the connector) needs to know what just happened, what's
// open, and what Alfred is still working on, without falling back to vault
// walks. Backing endpoints are all under packages/ctrl/src/api/routes/
// {briefings,decisions,stateChanges,attention,openclaw}.ts.

const briefDecisionTools: ToolDef[] = [
  {
    name: "list_briefings",
    description:
      "List the principal's morning / evening brief snapshots written by BriefingWorkflow. Each entry summarises one slot: `slug_date` (e.g. `2026-05-14-morning`), `slot`, `composed_at`, plus the observed counts (`observed_matters_count`, `state_changes_count`, `signals_count`, `decisions_count`). Use this to find a specific brief before calling `get_briefing` for the body, or to answer 'when was the last brief?' / 'show me this week's briefs.' Filters: `slot` (morning|evening|all), `since`/`until` ISO timestamps over `composed_at`, `limit` (default 20, cap 100). Backing: filesystem walk of /vault/briefing/ via /api/v1/briefings.",
    inputSchema: z.object({
      slot: z.enum(["all", "morning", "evening"]).optional().describe(
        "Filter to one slot. Default `all`.",
      ),
      since: z.string().optional().describe(
        "ISO timestamp; only briefs with composed_at >= since.",
      ),
      until: z.string().optional().describe(
        "ISO timestamp; only briefs with composed_at <= until.",
      ),
      limit: z.number().int().min(1).max(100).optional().describe(
        "Max entries (default 20, cap 100).",
      ),
    }),
    buildRequest: (args) => ({
      method: "GET",
      path: "/api/v1/briefings",
      query: args,
    }),
  },
  {
    name: "get_briefing",
    description:
      "Read ONE brief snapshot by its slug-date — the body the principal sees on /brief plus all frontmatter. Use AFTER `list_briefings` (don't guess slug-dates; they're `YYYY-MM-DD-<slot>`). The body is letterpress prose written by Alfred from post-mutation matter state plus signals + decisions in the window; the frontmatter carries `composed_at`, `prior_briefing`, `window_start`/`end`, and the counts. Use to answer 'what did this morning's brief say?' or to ground a follow-up action ('did the brief mention X?'). Backing: GET /api/v1/briefings/:slug-date.",
    inputSchema: z.object({
      slug_date: z.string().min(1).describe(
        "Brief identifier — `YYYY-MM-DD-<slot>`, e.g. `2026-05-14-morning`.",
      ),
    }),
    buildRequest: ({ slug_date }) => ({
      method: "GET",
      path: `/api/v1/briefings/${encodeURIComponent(slug_date)}`,
    }),
  },
  {
    name: "list_decisions",
    description:
      "List decision records — choices the principal (or Alfred autonomously) has made and the state-machine that closes the loop on each. Each entry carries `id`, `path`, plus the frontmatter: `intent` (delegate/done/noise/defer/hold), `state` (open/completed/...), `created`, `completed_at`, `note`, `matter_ref`, `outcome_record`, `source`. Filters: `state` (e.g. `open` or `completed`), `source` (e.g. `desk` for principal-originated, `decision-router.auto` for autonomous fires), `since` ISO timestamp, `limit` (default 100, cap 500). Use to answer 'what have you done autonomously this week?', 'what's still open?', 'show me everything I delegated yesterday.' Backing: filesystem walk + frontmatter scan via /api/v1/decisions.",
    inputSchema: z.object({
      state: z.string().optional().describe(
        "Filter on frontmatter.state. Common values: `open`, `completed`, `superseded`.",
      ),
      source: z.string().optional().describe(
        "Filter on frontmatter.source — where the decision originated. Examples: `desk` (principal click), `decision-router.auto` (autonomous), `learn.judgment`.",
      ),
      since: z.string().optional().describe(
        "ISO timestamp; only decisions with frontmatter.created >= since.",
      ),
      limit: z.number().int().min(1).max(500).optional().describe(
        "Max entries (default 100, cap 500).",
      ),
    }),
    buildRequest: (args) => ({
      method: "GET",
      path: "/api/v1/decisions",
      query: args,
    }),
  },
  {
    name: "get_decision",
    description:
      "Read ONE decision record by id — the principal's exact note, the matter it touches, what intent was chosen, and the outcome_record that closed the loop (when state=completed). Use AFTER `list_decisions` to inspect a specific decision's full body. Returns `{id, path, frontmatter, body}`. Backing: GET /api/v1/decisions/:id.",
    inputSchema: z.object({
      id: z.string().min(1).describe(
        "Decision id from list_decisions (e.g. `2026-05-14-acme-rsvp`).",
      ),
    }),
    buildRequest: ({ id }) => ({
      method: "GET",
      path: `/api/v1/decisions/${encodeURIComponent(id)}`,
    }),
  },
  {
    name: "list_pending_decisions",
    description:
      "List decision cards currently awaiting the principal's attention — what's on /desk right now. Each entry is a `needs_attention` record with frontmatter (`status`, `created`, `origin_at`, `actor`, `display_headline`, `display_body`, `target_path`, `decision_required`). Use BEFORE creating a new card / triage so you don't duplicate an existing one, and to answer 'what's on my desk?' / 'is there anything I haven't seen yet?'. Returns `{records, count}`; capped at 100 (max 500 via `limit`). `include=all` flips the filter to surface dismissed/completed cards too — default returns only `status: pending`. Backing: filesystem walk of /vault/needs_attention/ via /api/v1/admin/needs-attention.",
    inputSchema: z.object({
      include: z.enum(["pending", "all"]).optional().describe(
        "`pending` (default) returns only open cards. `all` includes dismissed/handled cards.",
      ),
      limit: z.number().int().min(1).max(500).optional().describe(
        "Max entries (default 100, cap 500).",
      ),
    }),
    buildRequest: ({ include, limit }) => ({
      method: "GET",
      path: "/api/v1/admin/needs-attention",
      query: {
        ...(include === "all" ? { include: "all" } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    }),
  },
  {
    name: "act_on_decision",
    description:
      // Sir's voice — clear, no fluff. The model on the other end of the
      // connector picks an action and sometimes types a prompt; that prompt
      // (instructions / when / context) lands here as `note`.
      "Act on ONE decision card sitting on Sir's desk — the exact same five buttons Sir clicks on /desk (Delegate · Defer · Done · Do · Noise) wrapped into one tool. Always `list_pending_decisions` first so you know which `id` you're acting on and which action fits.\n" +
      "\n" +
      "Action menu (mirrors the dashboard exactly):\n" +
      "  • `delegate` — hand it to Alfred to do. ctrl-api re-arms the source signal and the router fires the matched instinct's agent. REQUIRES `note` = the instructions Sir would type into the 'Instructions for me' box (e.g. 'Settle it, then file the receipt under May expenses.'). 2xx with `nothing_to_delegate: true` means the card had no real signal behind it (advisory card) and stays on the Desk — surface that to Sir verbatim.\n" +
      "  • `defer` — bury the card until a named time. REQUIRES `note` = the natural-language when ('Tomorrow morning', 'After the Carter meeting'). DecisionRouterWorkflow parses it and stamps `resurface_at`; the card drops off /desk and returns then.\n" +
      "  • `done` — mark the card resolved. `note` is OPTIONAL context ('Already replied', 'Paid on call', 'Resolved on the thread'). The note also seeds an observation for the learning pipeline, so a one-line context is worth more than empty.\n" +
      "  • `do` — Sir's taking this on himself. A to_do/<ts>.md spawns within ~60s and surfaces in his Backstage. `note` OPTIONAL — anything Sir wants in the to_do body.\n" +
      "  • `noise` — this kind of card should never have surfaced. The card drops off /desk and the learning layer materialises a `signal_noise_pattern` so the next one like it is filtered upstream. `note` is OPTIONAL (the gesture itself is the explanation; leave it empty unless Sir says why).\n" +
      "\n" +
      "Defaults: `source` defaults to `needs_attention` (the common case — the card came from Sir's Desk). Override only when the card came from `approval`, `judgment`, `to_do`, `pattern_proposal`, or a `desk_originated` decision you just wrote. `id` is the needs_attention stem from `list_pending_decisions` (e.g. `2026-05-28-04-15-xyz`), NOT the wrapped `needs_attention/<id>.md` path — the tool wraps it for you.\n" +
      "\n" +
      "Returns the created decision record `{id, path, frontmatter, side_effects}`. `side_effects.dispatch_ok: false` on a delegate means the agent fired but no real backend work happened (advisory card / nothing to delegate); the card stays on the Desk in that case. Backing: POST /api/v1/decisions — the exact endpoint the dashboard buttons hit. NOT idempotent: each call writes a decision record; the synchronous source-record flip prevents double-handling of the same card, but a retry against an already-handled card returns the new decision with the source already in its target state.",
    inputSchema: z
      .object({
        id: z.string().min(1).describe(
          "Source-record id — for a Desk card, the `id` field from `list_pending_decisions` (the needs_attention stem). For other sources, the bare record id; the tool wraps the path for `needs_attention` only.",
        ),
        action: z.enum(["delegate", "defer", "done", "do", "noise"]).describe(
          "Which Desk button to press. delegate=hand to Alfred · defer=resurface later · done=mark resolved · do=Sir takes it (spawns a to_do) · noise=mark as low-signal so the pattern is filtered upstream.",
        ),
        note: z.string().optional().describe(
          "The prompt the dashboard collects per action. REQUIRED for `delegate` (instructions for Alfred) and `defer` (natural-language when, e.g. 'tomorrow morning'). OPTIONAL for `done` (resolution context — seeds the learning observation) and `do` (to_do body). Pass empty / omit for `noise`.",
        ),
        source: z
          .enum([
            "needs_attention",
            "approval",
            "judgment",
            "to_do",
            "desk_originated",
            "pattern_proposal",
            "instinct_fire",
          ])
          .optional()
          .describe(
            "Where the card came from. Defaults to `needs_attention` (the Desk queue). Override only when acting on an approval, judgment, to_do, pattern_proposal, or desk-originated decision.",
          ),
        matter_ref: z.string().optional().describe(
          "Optional matter wikilink/path to attach (e.g. `matter/acme.md`). ctrl-api backfills this from the needs_attention record's target_path when omitted, so you rarely need to set it.",
        ),
        task_ref: z.string().optional().describe(
          "Optional task wikilink/path to attach (e.g. `task/follow-up-sam.md`). Same backfill rule as `matter_ref`.",
        ),
        source_headline: z.string().optional().describe(
          "Optional headline copied onto the decision record for ledger readability. Defaults to empty; the dashboard passes the card's `display_headline` when it has one.",
        ),
      })
      .superRefine((v, ctx) => {
        // Action-level required-note validation: mirrors the dashboard,
        // where Delegate and Defer reveal a text input the user MUST fill.
        // Done / Do / Noise have an optional input.
        const needsNote = v.action === "delegate" || v.action === "defer";
        if (needsNote && (!v.note || !v.note.trim())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["note"],
            message:
              v.action === "delegate"
                ? "`note` is required for `delegate` — pass the instructions Sir would give Alfred (e.g. 'Settle it, then file the receipt')."
                : "`note` is required for `defer` — pass the natural-language when (e.g. 'Tomorrow morning', 'After the Carter meeting').",
          });
        }
      }),
    buildRequest: ({ id, action, note, source, matter_ref, task_ref, source_headline }) => {
      const src = source ?? "needs_attention";
      // The dashboard wraps the needs_attention id as `needs_attention/<id>.md`
      // before POSTing; for other sources the recordId is passed verbatim.
      // Mirror that exactly so ctrl-api's synchronous source-flip finds the
      // right file.
      const sourceRecord =
        src === "needs_attention" ? `needs_attention/${id}.md` : id;
      // Map the user-facing action onto the ctrl-api intent enum. `delete`
      // is a dashboard-side label only — we use Sir's plainer word `done`
      // for both the action and the intent, and translate `do` → `take_mine`
      // here so callers stay in dashboard vocabulary.
      const intent =
        action === "do" ? "take_mine" : (action as "delegate" | "defer" | "done" | "noise");
      return {
        method: "POST",
        path: "/api/v1/decisions",
        body: {
          source: src,
          source_record: sourceRecord,
          intent,
          note: note ?? "",
          matter_ref: matter_ref ?? "",
          task_ref: task_ref ?? "",
          source_headline: source_headline ?? "",
          time_to_decision_ms: null,
        },
      };
    },
  },
  {
    name: "reverse_decision",
    description:
      "Undo a decision Sir (or Alfred autonomously) just made — flips state→reversed and the DecisionRouterWorkflow runs inverse side-effects on its next 60s tick (source-record status flips back onto the Desk, any spawned to_do gets cancelled). Use when Sir says 'undo that', 'I changed my mind on the Carter card', or after `act_on_decision` returned something that's clearly wrong.\n" +
      "\n" +
      "Caveat: reverse is best-effort. For `intent=delegate`, the source-record flip is reversible but an agent that already fired CANNOT be unsent — Sir gets the Desk card back, but the dispatched work in the world isn't rewound. ctrl-api marks `delegate` as not-reversible in its frontmatter (`is_reversible: false`) — calling reverse on one returns 400 with that reason. The other four intents (defer/done/take_mine/noise) reverse cleanly.\n" +
      "\n" +
      "Returns `{ok: true, id, path, frontmatter}` (or `{ok: true, id, already_reversed: true}` on a no-op). Idempotent. Backing: POST /api/v1/decisions/:id/reverse.",
    inputSchema: z.object({
      id: z.string().min(1).describe(
        "Decision id — e.g. `2026-05-28T04-15-22Z-a1b2c3d4`. Get it from `list_decisions` or from the `id` field in a prior `act_on_decision` response.",
      ),
    }),
    buildRequest: ({ id }) => ({
      method: "POST",
      path: `/api/v1/decisions/${encodeURIComponent(id)}/reverse`,
    }),
  },
  {
    name: "list_state_changes",
    description:
      "List entries from the state-change audit ledger — the canonical record of every mutation to matter / task state-fields written through state_mutator v2 (per docs/STATE-MUTATION.md). Each entry: `{when, source, target_kind, target_path, fields_changed, reason, audit_record_path}`. Filters: `target` (full vault-relative target_path like `matter/acme.md`), `source` (writer name, e.g. `briefing.morning`, `steward`, `nightly_narrative`, `manual.<userid>`), `since` / `until` ISO timestamps, `limit` (default 50, cap 200), `offset`. Use to answer 'who changed this matter?', 'show me everything Steward did last hour', 'what mutated under the briefing source today'. Backing: indexed vault walk via /api/v1/state-changes.",
    inputSchema: z.object({
      target: z.string().optional().describe(
        "Filter by exact target path (e.g. `matter/acme.md` or `task/follow-up-sam.md`).",
      ),
      source: z.string().optional().describe(
        "Filter by writer name (e.g. `briefing.morning`, `steward`, `nightly_narrative`, `manual.<userid>`).",
      ),
      since: z.string().optional().describe(
        "ISO timestamp; only entries with when >= since.",
      ),
      until: z.string().optional().describe(
        "ISO timestamp; only entries with when <= until.",
      ),
      limit: z.number().int().min(1).max(200).optional().describe(
        "Max entries (default 50, cap 200).",
      ),
      offset: z.number().int().min(0).optional().describe(
        "Pagination offset (default 0). Pair with `limit`.",
      ),
    }),
    buildRequest: (args) => ({
      method: "GET",
      path: "/api/v1/state-changes",
      query: args,
    }),
  },
  {
    name: "list_in_flight_agents",
    description:
      "List ephemeral exec-* subagents that Alfred has spawned and not yet torn down — the live delegations the system is currently working through. Each entry: `{id, name, model, tools_allow_count, started_at_hint}`. Distinct from `list_agents` (static personas: main, learn-clerk, vault-curator, …) and from `list_openclaw_agents` (the gateway's full agent registry). Use to answer 'what are you working on right now?', or BEFORE creating another exec agent to avoid double-spawning. Returns `{agents, count, last_touched_at}`; empty list when no delegations are in flight. Backing: GET /api/v1/openclaw/agents/ephemeral (workers gateway config filtered to `exec-*` prefix).",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "GET",
      path: "/api/v1/openclaw/agents/ephemeral",
    }),
  },
];

// ─── tool disposition + focused subagent delegation (Phase B) ───────────────
//
// Sir's "both tracks" architecture (see plan i-want-you-to-snazzy-pixel.md §B):
// every MCP server registered on the main profile carries a runtime-flippable
// DIRECT-or-DELEGATED disposition. DIRECT = LLM calls native tools. DELEGATED
// = tools hidden on main; LLM uses `delegate_to_focused_agent` instead. Sir
// flips via dashboard or voice ("Alfred, demote sure to delegated") through
// `set_tool_disposition`; Alfred glances the current map via
// `list_tool_dispositions` at session start.
//
// The catalogue of 9 servers mirrors migration 0014's seed.

const DISPOSITION_SERVERS = [
  "alfred-ctrl",
  "alfred",
  "sure",
  "plane",
  "vaultwarden",
  "execute",
  "paperclip",
  "hass",
  "files",
] as const;

const dispositionTools: ToolDef[] = [
  {
    name: "list_tool_dispositions",
    description:
      "List the current direct-or-delegated disposition for each of Sir's 9 MCP servers (alfred-ctrl, alfred, sure, plane, vaultwarden, execute, paperclip, hass, files). DIRECT = the server's tools are in your catalogue this turn (call them natively, e.g. `sure_list_accounts`). DELEGATED = its tools are HIDDEN from your catalogue; you reach them only through `delegate_to_focused_agent({domain:'sure',...})` which spawns a one-shot workers-profile subagent that loads the right skill and returns plain text. Use at the top of a session if you're not sure of the current map — disposition can change between turns (Sir flips via dashboard or voice). Cheap and idempotent. Returns `{dispositions: [{server, disposition, updated_at, updated_by}, ...]}`. Backing: GET /api/v1/agents/tool-disposition.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "GET", path: "/api/v1/agents/tool-disposition" }),
  },
  {
    name: "set_tool_disposition",
    description:
      "Flip one MCP server between DIRECT (native tools available on main, ~2-4k tokens per turn each) and DELEGATED (tools hidden from main; accessed via `delegate_to_focused_agent`; saves tokens but adds ~3-5s per tool use). Use when Sir says 'demote X to delegated', 'promote X to direct', 'hide the sure tools', 'bring paperclip back to main', or when you notice tokens-per-turn climbing and want to suggest the flip yourself. Triggers a ~10s debounced Hermes restart (a burst of flips coalesces into one restart). After the restart the new disposition is live; tell Sir 'I've queued the restart — give it about 10 seconds'.\n" +
      "\n" +
      "SELF-PROTECTION RULE — these three servers control Alfred's own self-management surface and a careless DELEGATE could brick the very tools you'd need to undo it: `alfred-ctrl` (admin/agents/state/health), `alfred` (vault + decisions + briefings + this very disposition surface), `execute` (Composio gateway). NEVER flip any of these three without Sir's explicit confirmation phrase: \"yes, change my Alfred's tool disposition\" (case-insensitive, must appear verbatim in his most recent message). If Sir asks to demote one of these and hasn't said the confirmation phrase, push back: 'Sir, flipping `alfred-ctrl` to delegated would hide your own self-management tools. Confirm with \"yes, change my Alfred's tool disposition\" if you really want this.' Same pattern as the alfred-ha self-destruct guard.\n" +
      "\n" +
      "Backing: POST /api/v1/agents/tool-disposition. NOT idempotent in side effects (every call re-arms the debounce timer); idempotent in steady-state (calling set('sure','delegated') twice leaves sure at delegated).",
    inputSchema: z.object({
      server: z.enum(DISPOSITION_SERVERS).describe(
        "MCP server to flip. The 9 servers exactly mirror what ships on main: alfred-ctrl, alfred, sure, plane, vaultwarden, execute, paperclip, hass, files.",
      ),
      disposition: z.enum(["direct", "delegated"]).describe(
        "Target disposition. `direct` = native tools available on main. `delegated` = tools hidden on main; reachable via delegate_to_focused_agent.",
      ),
      updated_by: z.enum(["sir", "alfred"]).optional().describe(
        "Audit attribution. `sir` when Sir explicitly asked for the flip (voice or dashboard); `alfred` when you initiated the suggestion yourself. Defaults to `alfred`.",
      ),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/agents/tool-disposition",
      body: {
        server: args.server,
        disposition: args.disposition,
        updated_by: args.updated_by ?? "alfred",
      },
    }),
  },
  {
    name: "delegate_to_focused_agent",
    description:
      "Spawn a short-lived focused subagent on the workers profile (cheaper model, same Alfred identity + same vault memory) to handle ONE task that needs a heavy tool surface. Use this when:\n" +
      "  (1) the target server is currently DELEGATED in tool_disposition — `list_tool_dispositions` shows the live map; you have no native tools from that server this turn so delegation is the ONLY path.\n" +
      "  (2) you're doing a tool-heavy fanout (gmail batch over many messages, calendar across multiple calendars, paperclip multi-issue update, sure transaction triage across N transactions) — even if the server is DIRECT, fanning out 10-20 calls inline blows the context budget and stalls Voice PE; delegating bundles the work into one round-trip.\n" +
      "\n" +
      "How it works: ctrl-api builds a workers-profile session key `focus-<domain>-<hash>`, attaches a skill-load directive (`alfred-<domain>-skill.md` OR `alfred-composio-<domain>-skill.md`), posts to Hermes workers :18790/v1/responses with your task + optional context, and returns the subagent's plain-text reply. Cost: ~3-5s spawn + the subagent's actual work (typically 5-30s for tool-heavy fanouts).\n" +
      "\n" +
      "RELAY THE SUBAGENT'S REPLY VERBATIM. Don't summarize, don't reformat unless the channel truly demands it. The subagent's wording is calibrated for direct relay; rewriting it dilutes correctness and burns tokens.\n" +
      "\n" +
      "Backing: POST /api/v1/agents/focused-subagent. 60s timeout. Returns `{ok, reply, session_key, domain}`. NOT idempotent — each call spawns a fresh session.",
    inputSchema: z.object({
      task: z.string().min(1).describe(
        "What the subagent should do, in plain language. BE SPECIFIC — the subagent doesn't see this conversation, only your task + the optional context. Include any record paths, vault slugs, recipient handles, time windows, etc.",
      ),
      domain: z.string().min(1).describe(
        "Which tool surface the subagent needs. For MCP servers, use the server name: `sure` / `plane` / `vaultwarden` / `paperclip` / `hass` / `files` / `execute` / `alfred` / `alfred-ctrl`. For a Composio toolkit, use the toolkit slug: `googlecalendar` / `gmail` / `notion` / `linear` / `slack` / etc. The subagent uses this label to load the right skill.",
      ),
      context: z.string().optional().describe(
        "Optional 1-2 sentences from this conversation that help the subagent ground its answer (e.g. 'Sir's primary calendar is the one called Personal, id <calendar-id>.'). Keep it tight — long context blows the same token budget you're trying to save by delegating.",
      ),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/agents/focused-subagent",
      body: args,
    }),
  },
];

// ─── channels (notify the principal via main openclaw) ──────────────────────

// Outbound channels (Telegram, Slack, …) belong to the MAIN Hermes profile
// — its gateway holds the channel bindings + bot tokens. Workers-side agents
// (learn-clerk, ephemeral exec-*) run on the `workers` profile, which has no
// messaging toolset, so they cannot reach a channel directly.
// ctrl-api bridges them via /api/v1/notifications: the request lands on
// ctrl-api, which (issue #45) creates a one-shot Hermes `main`-profile cron
// job with deliver=<channel>:<to>, triggers it for immediate execution, and
// waits for the Hermes scheduler to deliver the message to the channel.
// Recipient resolution happens server-side via pickPrimaryChannel() +
// resolveRecipient() against the native Hermes session index.

const channelTools: ToolDef[] = [
  {
    name: "notify_principal",
    description:
      "Send a message to Sir on his preferred channel (Telegram, Slack, …). USE THIS — never composio_execute — when the principal asks you to ping/notify/remind him. Telegram is NOT a Composio toolkit; it's a Hermes main-profile channel, and only the main runtime can reach it. This tool bridges that: ctrl-api creates a one-shot Hermes main-profile cron job that delivers the message to the named channel, and returns delivered:true only once the channel send is confirmed (a failure comes back as a real error, never a silent no-op). Auto-picks the tenant's primary channel when you pass channel='auto' or omit it. When Sir explicitly names a channel (\"send me a reminder on Telegram\"), pass that channel slug — do NOT rely on auto. Backing: POST /api/v1/notifications → Hermes main-profile cron job with deliver=<channel>:<to>.",
    inputSchema: z.object({
      message: z.string().min(1).describe(
        "The text to send Sir. Plain text; no markdown formatting unless the channel renders it. Keep it tight — this lands as a notification, not a document.",
      ),
      channel: z
        .enum(["auto", "telegram", "slack"])
        .optional()
        .describe(
          "Channel name. 'auto' (default) picks the tenant's primary channel server-side. Pass 'telegram' or 'slack' explicitly whenever Sir names a channel — auto is a fallback, not a Sir-aware resolver.",
        ),
      urgency: z
        .enum(["normal", "high"])
        .optional()
        .describe(
          "Message urgency. 'normal' (default) for routine pings; 'high' for time-sensitive ones — some channels render high-urgency messages with elevated push priority.",
        ),
      to: z
        .string()
        .optional()
        .describe(
          "Optional explicit recipient address (channel-specific id). Almost never needed — leave unset and ctrl-api resolves Sir's paired identity for the chosen channel. Useful only when sending to a NON-principal recipient on a channel where the bot has multi-recipient access.",
        ),
    }),
    buildRequest: ({ message, channel, urgency, to }) => ({
      method: "POST",
      path: "/api/v1/notifications",
      body: {
        message,
        channel: channel ?? "auto",
        urgency: urgency ?? "normal",
        ...(to ? { to } : {}),
      },
    }),
  },
];

// ─── flat catalogue ─────────────────────────────────────────────────────────

export const ALL_ALFRED_TOOLS: ToolDef[] = [
  ...vaultTools,
  ...agentTools,
  ...workflowTools,
  ...openclawTools,
  ...deviceTools,
  ...briefDecisionTools,
  ...dispositionTools,
  ...channelTools,
];
