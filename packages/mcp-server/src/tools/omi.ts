import { z } from "zod";
import type { ToolDef } from "./types.js";
const root = "/api/v1/channels/omi/pilot";
// Omi converts top-level primitive fields to its host tool schema.
const taskFields = {
  title: z.string().min(1).max(1000),
  due_date: z
    .string()
    .describe("ISO date/time, or an empty string for no due date"),
  completed: z.boolean(),
};
const taskBody = (args: Record<string, unknown>) => {
  const { title, due_date, completed, ...rest } = args;
  return { ...rest, task: { title, due_at: due_date || null, completed } };
};
// Separate app: no administrative or raw Composio write tools.
export const ALL_OMI_TOOLS: ToolDef[] = [
  {
    name: "omi_context",
    description:
      "Call before EVERY reply. Load your actual identity, language, relevant matters, tasks and shared conversation history. You are the assistant described by this context, even in Omi. Refreshes Omi history. Never confuse a pending request with completed work.",
    inputSchema: z.object({ message: z.string().min(1).max(8000) }),
    buildRequest: (args) => ({
      method: "POST",
      path: root + "/context",
      body: args,
    }),
  },
  {
    name: "omi_read",
    description:
      "Read business records, list management tasks, or discover connected applications. Use context first. Administrative access and secrets are not available.",
    inputSchema: z.object({
      kind: z.enum(["record", "tasks", "connections"]),
      path: z.string().optional(),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: root + "/read",
      body: args,
    }),
  },
  {
    name: "omi_task_create",
    description:
      "Create a canonical management task and queue it for the Omi task list. Requires enabled task synchronization. Reuse the same request_id for retries; do not replace it after a timeout.",
    inputSchema: z.object({
      request_id: z.string().min(8).max(160),
      ...taskFields,
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: root + "/command",
      body: { ...taskBody(args), operation: "create_task" },
    }),
  },
  {
    name: "omi_task_update",
    description:
      "Update title, due date or completion of a task already connected to Omi. Preserve unspecified fields by reading first. Reuse request_id on retries.",
    inputSchema: z.object({
      request_id: z.string().min(8).max(160),
      task_path: z.string(),
      ...taskFields,
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: root + "/command",
      body: { ...taskBody(args), operation: "update_task" },
    }),
  },
  {
    name: "omi_request_work",
    description:
      "Record a request for work involving connected applications or workflows for human review. This DOES NOT send email, run a workflow or execute the requested action. Report awaiting review, never done. Reuse request_id on retries.",
    inputSchema: z.object({
      request_id: z.string().min(8).max(160),
      ...taskFields,
      request: z.string().min(1).max(8000),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: root + "/command",
      body: { ...taskBody(args), operation: "request_work" },
    }),
  },
];
