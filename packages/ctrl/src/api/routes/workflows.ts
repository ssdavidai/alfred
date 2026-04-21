import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { dockerExec, parseJsonLines } from "../helpers.js";

const ONBOARD_JSON_PATH = "/mnt/encrypted/alfred/onboard.json";

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

  // Start onboarding pipeline workflow (v2)
  addRoute("POST", "/api/v1/workflows/onboarding/start", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.user_id !== "string") {
      throw new ValidationError("user_id is required");
    }

    const workflowId = `onboarding-${b.user_id}-${Date.now()}`;
    const args = [
      "temporal", "workflow", "start",
      "--type", "OnboardingPipelineWorkflow",
      "--task-queue", "alfred-learn",
      "--workflow-id", workflowId,
      "--input", JSON.stringify({ user_id: b.user_id, stream_id: b.stream_id ?? "" }),
    ];

    const stdout = await dockerExec("temporal", args);
    try {
      const result = JSON.parse(stdout);
      sendJson(res, 201, { workflow_id: workflowId, ...result });
    } catch {
      sendJson(res, 201, { workflow_id: workflowId, raw: stdout });
    }
  });

  // A.2: Read suggested_streams from onboard.json
  // generate_stream_pack writes a list of {name, type, description, detected_from_domain}
  // entries during onboarding Stage 7. The SaaS-side applyStreamSuggestions
  // action reads these via this route and creates Stream rows for the
  // sources where we already have credentials (e.g. gmail after Google
  // signup). The list is consulted by the UI in A.3 too.
  addRoute("GET", "/api/v1/onboarding/suggested-streams", async ({ res }) => {
    try {
      const raw = fs.readFileSync(ONBOARD_JSON_PATH, "utf-8");
      const data = JSON.parse(raw);
      const suggestions = Array.isArray(data.suggested_streams)
        ? data.suggested_streams
        : [];
      sendJson(res, 200, {
        suggested_streams: suggestions,
        count: suggestions.length,
      });
    } catch {
      // onboard.json may not exist yet
      sendJson(res, 200, {
        suggested_streams: [],
        count: 0,
      });
    }
  });

  // Get onboarding progress (reads /mnt/encrypted/alfred/onboard.json)
  addRoute("GET", "/api/v1/onboarding/progress", async ({ res }) => {
    try {
      const raw = fs.readFileSync(ONBOARD_JSON_PATH, "utf-8");
      const data = JSON.parse(raw);
      sendJson(res, 200, {
        stage: data.stage ?? "unknown",
        progress: data.progress ?? { current_day: 0, total_days: 0, facts_count: 0, patterns_count: 0 },
        facts_count: data.facts?.length ?? 0,
        patterns_count: data.patterns?.length ?? 0,
        automations_count: data.automations?.length ?? 0,
        brief: data.brief ?? "",
        key_identity_facts: data.key_identity_facts ?? [],
      });
    } catch {
      // File doesn't exist yet — onboarding hasn't started
      sendJson(res, 200, {
        stage: "not_started",
        progress: { current_day: 0, total_days: 0, facts_count: 0, patterns_count: 0 },
        facts_count: 0,
        patterns_count: 0,
        automations_count: 0,
        brief: "",
      });
    }
  });

  // POST /api/v1/onboarding/corrections — submit fact corrections, advance stage to "brief",
  // then trigger a new onboarding workflow to generate the brief.
  addRoute("POST", "/api/v1/onboarding/corrections", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    const corrections = (b?.corrections ?? {}) as Record<string, string>;

    try {
      const raw = fs.readFileSync(ONBOARD_JSON_PATH, "utf-8");
      const data = JSON.parse(raw);
      data.fact_corrections = corrections;
      data.stage = "brief";
      fs.writeFileSync(ONBOARD_JSON_PATH, JSON.stringify(data, null, 2));

      // Trigger a new onboarding workflow to pick up from "brief" stage.
      // The previous workflow already exited after awaiting_verification.
      const userId = data.user_id ?? "";
      const streamId = data.stream_id ?? "";
      if (userId) {
        const workflowId = `onboarding-${userId}-brief-${Date.now()}`;
        try {
          await dockerExec("temporal", [
            "temporal", "workflow", "start",
            "--type", "OnboardingPipelineWorkflow",
            "--task-queue", "alfred-learn",
            "--workflow-id", workflowId,
            "--input", JSON.stringify({ user_id: userId, stream_id: streamId }),
          ]);
        } catch (e: any) {
          console.error("Failed to trigger brief workflow:", e.message);
        }
      }

      sendJson(res, 200, { status: "corrections_saved", stage: "brief" });
    } catch {
      sendJson(res, 500, { error: "Failed to save corrections" });
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
      "--type", b.workflow_type as string,
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

  // Rewrite a schedule's cron in place by DELETE + CREATE. Preserves workflow
  // type, task queue, and input. Needed because Temporal CLI has no
  // update-cron verb and the old schedules on fleet are wrong — see #475.
  addRoute("POST", "/api/v1/schedules/:schId/rewrite-cron", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.cron !== "string" || !(b.cron as string).trim()) {
      throw new ValidationError("body.cron (string) is required");
    }
    const schId = params.schId;
    const newCron = (b.cron as string).trim();

    // 1. Describe the existing schedule so we can preserve workflow metadata.
    const describeOut = await dockerExec("temporal", [
      "temporal", "schedule", "describe",
      "--schedule-id", schId,
      "--output", "json",
    ]);
    let described: any;
    try {
      described = JSON.parse(describeOut);
    } catch {
      throw new ValidationError(`Could not parse describe output for ${schId}`);
    }

    const action = described?.scheduleInfo?.action || described?.schedule?.action || {};
    const startWorkflow = action?.startWorkflow || action;
    const workflowType =
      startWorkflow?.workflowType?.name ||
      startWorkflow?.workflowType ||
      startWorkflow?.type;
    const taskQueue =
      startWorkflow?.taskQueue?.name ||
      startWorkflow?.taskQueue;
    if (!workflowType || !taskQueue) {
      throw new ValidationError(
        `Schedule ${schId} is missing workflowType or taskQueue in describe output`,
      );
    }
    // Preserve input args if any were recorded.
    const inputsRaw = startWorkflow?.input || startWorkflow?.args || [];
    let inputJson: string | undefined;
    if (Array.isArray(inputsRaw) && inputsRaw.length > 0) {
      // Temporal CLI accepts JSON per-arg; join as an array.
      inputJson = JSON.stringify(inputsRaw[0]);
    }

    // Preserve overlap policy (Skip / BufferOne / BufferAll / CancelOther /
    // TerminateOther / AllowAll). Fall back to SKIP which is Temporal default.
    const overlapPolicy =
      described?.schedule?.policies?.overlapPolicy ||
      described?.info?.policies?.overlapPolicy ||
      "SCHEDULE_OVERLAP_POLICY_SKIP";
    const overlapFlag = _overlapPolicyToCli(overlapPolicy);

    // 2. Delete the old schedule.
    await dockerExec("temporal", ["temporal", "schedule", "delete", "--schedule-id", schId]);

    // 3. Create with the new cron, preserving everything else.
    const createArgs = [
      "temporal", "schedule", "create",
      "--schedule-id", schId,
      "--type", String(workflowType),
      "--task-queue", String(taskQueue),
      "--cron", newCron,
    ];
    if (inputJson) createArgs.push("--input", inputJson);
    if (overlapFlag) createArgs.push("--overlap-policy", overlapFlag);

    const createOut = await dockerExec("temporal", createArgs);
    sendJson(res, 200, {
      message: "Schedule rewritten",
      schedule_id: schId,
      old_cron_replaced: true,
      new_cron: newCron,
      workflow_type: workflowType,
      raw: createOut.trim() || undefined,
    });
  });
}

function _overlapPolicyToCli(policy: string | undefined): string | undefined {
  if (!policy) return undefined;
  const p = String(policy).toUpperCase();
  // Temporal's describe output uses full enum names; the CLI wants the short
  // form after the last underscore (Skip, BufferOne, etc.)
  const map: Record<string, string> = {
    SCHEDULE_OVERLAP_POLICY_SKIP: "Skip",
    SCHEDULE_OVERLAP_POLICY_BUFFER_ONE: "BufferOne",
    SCHEDULE_OVERLAP_POLICY_BUFFER_ALL: "BufferAll",
    SCHEDULE_OVERLAP_POLICY_CANCEL_OTHER: "CancelOther",
    SCHEDULE_OVERLAP_POLICY_TERMINATE_OTHER: "TerminateOther",
    SCHEDULE_OVERLAP_POLICY_ALLOW_ALL: "AllowAll",
  };
  return map[p] ?? "Skip";
}
