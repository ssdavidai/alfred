import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { dockerExec, parseJsonLines } from "../helpers.js";

export function registerWorkflowRoutes(): void {
  // --- Workflows ---

  // List workflows
  addRoute("GET", "/api/v1/workflows", async ({ res, query }) => {
    const args = ["temporal", "workflow", "list", "--output", "json"];
    const q = query.get("query");
    if (q) args.push("--query", q);
    const stdout = await dockerExec("temporal", args);
    sendJson(res, 200, parseJsonLines(stdout));
  });

  // Describe workflow
  addRoute("GET", "/api/v1/workflows/:wfId", async ({ res, params, query }) => {
    const args = ["temporal", "workflow", "describe", "--workflow-id", params.wfId, "--output", "json"];
    const runId = query.get("run_id");
    if (runId) args.push("--run-id", runId);
    const stdout = await dockerExec("temporal", args);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, parseJsonLines(stdout));
    }
  });

  // Start workflow
  addRoute("POST", "/api/v1/workflows", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.workflow_type !== "string" || typeof b.task_queue !== "string") {
      throw new ValidationError("workflow_type and task_queue are required");
    }

    const args = [
      "temporal", "workflow", "start",
      "--type", b.workflow_type as string,
      "--task-queue", b.task_queue as string,
      "--output", "json",
    ];
    if (b.workflow_id) args.push("--workflow-id", b.workflow_id as string);
    if (b.input !== undefined) args.push("--input", JSON.stringify(b.input));

    const stdout = await dockerExec("temporal", args);
    try {
      sendJson(res, 201, JSON.parse(stdout));
    } catch {
      sendJson(res, 201, { raw: stdout });
    }
  });

  // Terminate workflow
  addRoute("POST", "/api/v1/workflows/:wfId/terminate", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const args = ["temporal", "workflow", "terminate", "--workflow-id", params.wfId];
    if (b?.reason) args.push("--reason", b.reason as string);
    if (b?.run_id) args.push("--run-id", b.run_id as string);

    await dockerExec("temporal", args);
    sendJson(res, 200, { message: "Workflow terminated" });
  });

  // Signal workflow
  addRoute("POST", "/api/v1/workflows/:wfId/signal", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.signal_name !== "string") {
      throw new ValidationError("signal_name is required");
    }

    const args = [
      "temporal", "workflow", "signal",
      "--workflow-id", params.wfId,
      "--name", b.signal_name as string,
    ];
    if (b.input !== undefined) args.push("--input", JSON.stringify(b.input));
    if (b.run_id) args.push("--run-id", b.run_id as string);

    await dockerExec("temporal", args);
    sendJson(res, 200, { message: "Signal sent" });
  });

  // Cancel workflow
  addRoute("POST", "/api/v1/workflows/:wfId/cancel", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const args = ["temporal", "workflow", "cancel", "--workflow-id", params.wfId];
    if (b?.run_id) args.push("--run-id", b.run_id as string);

    await dockerExec("temporal", args);
    sendJson(res, 200, { message: "Workflow cancelled" });
  });

  // Workflow history
  addRoute("GET", "/api/v1/workflows/:wfId/history", async ({ res, params, query }) => {
    const args = ["temporal", "workflow", "show", "--workflow-id", params.wfId, "--output", "json"];
    const runId = query.get("run_id");
    if (runId) args.push("--run-id", runId);
    const stdout = await dockerExec("temporal", args);
    sendJson(res, 200, parseJsonLines(stdout));
  });

  // --- Onboarding ---

  // Start onboarding pipeline workflow
  addRoute("POST", "/api/v1/workflows/onboarding/start", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.user_id !== "string" || typeof b.stream_id !== "string") {
      throw new ValidationError("user_id and stream_id are required");
    }

    const workflowId = `onboarding-${b.user_id}-${Date.now()}`;
    const args = [
      "temporal", "workflow", "start",
      "--type", "OnboardingPipelineWorkflow",
      "--task-queue", "alfred-learn",
      "--workflow-id", workflowId,
      "--input", JSON.stringify({ user_id: b.user_id, stream_id: b.stream_id }),
    ];

    const stdout = await dockerExec("temporal", args);
    try {
      const result = JSON.parse(stdout);
      sendJson(res, 201, { workflow_id: workflowId, ...result });
    } catch {
      sendJson(res, 201, { workflow_id: workflowId, raw: stdout });
    }
  });

  // --- Schedules ---

  // List schedules
  addRoute("GET", "/api/v1/schedules", async ({ res }) => {
    const stdout = await dockerExec("temporal", ["temporal", "schedule", "list", "--output", "json"]);
    sendJson(res, 200, parseJsonLines(stdout));
  });

  // Describe schedule
  addRoute("GET", "/api/v1/schedules/:schId", async ({ res, params }) => {
    const stdout = await dockerExec("temporal", [
      "temporal", "schedule", "describe", "--schedule-id", params.schId, "--output", "json",
    ]);
    try {
      sendJson(res, 200, JSON.parse(stdout));
    } catch {
      sendJson(res, 200, parseJsonLines(stdout));
    }
  });

  // Create schedule
  addRoute("POST", "/api/v1/schedules", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (
      !b ||
      typeof b.schedule_id !== "string" ||
      typeof b.workflow_type !== "string" ||
      typeof b.task_queue !== "string" ||
      typeof b.cron !== "string"
    ) {
      throw new ValidationError("schedule_id, workflow_type, task_queue, and cron are required");
    }

    const args = [
      "temporal", "schedule", "create",
      "--schedule-id", b.schedule_id as string,
      "--workflow-type", b.workflow_type as string,
      "--task-queue", b.task_queue as string,
      "--cron", b.cron as string,
    ];
    if (b.input !== undefined) args.push("--input", JSON.stringify(b.input));
    if (b.overlap_policy) args.push("--overlap-policy", b.overlap_policy as string);

    const stdout = await dockerExec("temporal", args);
    sendJson(res, 201, { message: "Schedule created", raw: stdout.trim() || undefined });
  });

  // Delete schedule
  addRoute("DELETE", "/api/v1/schedules/:schId", async ({ res, params }) => {
    await dockerExec("temporal", ["temporal", "schedule", "delete", "--schedule-id", params.schId]);
    sendJson(res, 200, { message: "Schedule deleted" });
  });

  // Pause schedule
  addRoute("POST", "/api/v1/schedules/:schId/pause", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const args = ["temporal", "schedule", "update", "--schedule-id", params.schId, "--pause"];
    if (b?.reason) args.push("--reason", b.reason as string);

    await dockerExec("temporal", args);
    sendJson(res, 200, { message: "Schedule paused" });
  });

  // Unpause schedule
  addRoute("POST", "/api/v1/schedules/:schId/unpause", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const args = ["temporal", "schedule", "update", "--schedule-id", params.schId, "--unpause"];
    if (b?.reason) args.push("--reason", b.reason as string);

    await dockerExec("temporal", args);
    sendJson(res, 200, { message: "Schedule unpaused" });
  });

  // Trigger schedule
  addRoute("POST", "/api/v1/schedules/:schId/trigger", async ({ res, params }) => {
    await dockerExec("temporal", ["temporal", "schedule", "trigger", "--schedule-id", params.schId]);
    sendJson(res, 200, { message: "Schedule triggered" });
  });
}
