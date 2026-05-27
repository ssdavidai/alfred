/**
 * Wake-up prompt builder.
 *
 * Lifted from upstream v0.2.0's `execute.ts::buildPrompt` so the agent
 * receives the same instructions whether it runs via the CLI or our HTTP
 * fork — keeps the principal's mental model "Alfred, the one thing"
 * intact (the agent's behaviour shouldn't drift based on transport).
 *
 * We intentionally inline the Mustache-lite handling instead of pulling
 * `@paperclipai/adapter-utils/server-utils::renderTemplate` so this
 * adapter has zero runtime deps — keeps the COPY-overlay surface tight.
 */

import type {
  AdapterAgent,
  AdapterExecutionContext,
} from "../types/paperclip.js";

const DEFAULT_PROMPT_TEMPLATE = `You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.

IMPORTANT: Use the \`paperclip\` MCP tools for ALL Paperclip API calls. Do NOT shell out to curl — the MCP surface is the supported path on this tenant.

Your Paperclip identity:
  Agent ID: {{agentId}}
  Company ID: {{companyId}}

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools.
2. When done, mark the issue as completed via the \`paperclip\` MCP \`updateIssue\` tool with \`status: "done"\`.
3. Post a completion comment summarizing what you did via \`paperclipAddComment\`.
4. If this issue has a parent (referenced as TRA-XX or similar in the body / comments), post a brief notification on the parent so the owner knows {{taskId}} is closed.
{{/taskId}}

{{#commentId}}
## Comment on This Issue

Someone commented on {{taskId}}. Read it via the \`paperclip\` MCP \`listComments\` tool, then address it (reply via \`paperclipAddComment\` if needed) and continue.
{{/commentId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List your open issues via the \`paperclip\` MCP \`listIssues\` tool with \`assigneeAgentId: "{{agentId}}"\`.
2. If issues found, pick the highest-priority non-done one and work on it: \`checkoutIssue\` → do the work → mark \`done\` + comment.
3. If no issues assigned to you, scan the company backlog (\`listIssues\` with \`status: "backlog"\`) and either pick one up (set \`assigneeAgentId: "{{agentId}}"\`, then proceed) or skip if nothing fits.
4. If truly nothing to do, post a brief status comment to the most recent open issue you've been involved with — never silently no-op.
{{/noTask}}`;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Renders the upstream template against `ctx`. The Mustache subset we
 * support is exactly what upstream uses: `{{var}}` and
 * `{{#section}}...{{/section}}` conditional blocks.
 */
export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  agent: AdapterAgent,
): string {
  const template = asString(config.promptTemplate) ?? DEFAULT_PROMPT_TEMPLATE;
  const cfg = (ctx.config ?? {}) as Record<string, unknown>;

  const taskId = asString(cfg.taskId) ?? "";
  const taskTitle = asString(cfg.taskTitle) ?? "";
  const taskBody = asString(cfg.taskBody) ?? "";
  const commentId = asString(cfg.commentId) ?? "";
  const wakeReason = asString(cfg.wakeReason) ?? "";
  const agentName = asString(agent.name) ?? "Hermes Agent";
  const companyName = asString(cfg.companyName) ?? "";
  const projectName = asString(cfg.projectName) ?? "";

  const vars: Record<string, string> = {
    agentId: asString(agent.id) ?? "",
    agentName,
    companyId: asString(agent.companyId) ?? "",
    companyName,
    runId: asString(ctx.runId) ?? "",
    taskId,
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
  };

  let rendered = template;

  // {{#taskId}}...{{/taskId}}
  rendered = rendered.replace(
    /\{\{#taskId\}\}([\s\S]*?)\{\{\/taskId\}\}/g,
    taskId ? "$1" : "",
  );
  // {{#noTask}}...{{/noTask}}
  rendered = rendered.replace(
    /\{\{#noTask\}\}([\s\S]*?)\{\{\/noTask\}\}/g,
    taskId ? "" : "$1",
  );
  // {{#commentId}}...{{/commentId}}
  rendered = rendered.replace(
    /\{\{#commentId\}\}([\s\S]*?)\{\{\/commentId\}\}/g,
    commentId ? "$1" : "",
  );

  // Plain {{var}} substitutions — last so section markers don't leak.
  rendered = rendered.replace(/\{\{(\w+)\}\}/g, (_full, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] ?? "" : "",
  );

  return rendered;
}
