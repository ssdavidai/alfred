import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ApiError, ValidationError } from "../errors.js";
import { dockerExec, parseJsonLines } from "../helpers.js";

// alfred-black single-VM stacks mount the alfred-data named volume at
// /alfred-data inside ctrl-api (see docker-compose.yaml). Legacy multi-tenant
// stacks used /mnt/encrypted/alfred. Read the path from the environment so
// both topologies work without an api.mjs recompile; default to the
// alfred-black layout because that is the supported single-VM contract.
const ONBOARD_JSON_PATH =
  process.env.ONBOARD_JSON_PATH || "/alfred-data/onboard.json";

// Vault chore record dir. Kept in sync with VAULT_PATH from vault.ts (which
// we don't import here because the user-set file boundaries for #144 forbid
// editing other route files; chore lookup is read-only and the path is
// stable). Same env override as ONBOARD_JSON_PATH so both topologies work.
const CHORE_RECORD_DIR =
  process.env.CHORE_RECORD_DIR || "/vault/chore";

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
  //
  // OnboardingInput contract (P2→P3, Composio-managed Gmail onboarding #69):
  //   user_id         — SaaS User.id (required).
  //   stream_id       — the Gmail stream id (optional).
  //   gmail_mode      — "composio" | "google". Resolved ONCE by the web app
  //                     (resolveOnboardingGmailMode) at workflow start and
  //                     carried in OnboardingInput so the workflow branches
  //                     on a field, never on env (Temporal replay-safety).
  //                     Defaults to "google" when absent so pre-#69 callers
  //                     and in-flight workflows keep the legacy path.
  //   composio_action — e.g. "GMAIL_FETCH_EMAILS". Present only for the
  //                     composio path; tells P3's learn pipeline the exact
  //                     Composio fetch action without re-reading the stream.
  addRoute("POST", "/api/v1/workflows/onboarding/start", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.user_id !== "string") {
      throw new ValidationError("user_id is required");
    }

    const gmailMode = b.gmail_mode === "composio" ? "composio" : "google";
    const onboardingInput: Record<string, unknown> = {
      user_id: b.user_id,
      stream_id: b.stream_id ?? "",
      gmail_mode: gmailMode,
    };
    if (gmailMode === "composio" && typeof b.composio_action === "string") {
      onboardingInput.composio_action = b.composio_action;
    }

    const workflowId = `onboarding-${b.user_id}-${Date.now()}`;
    const args = [
      "temporal", "workflow", "start",
      "--type", "OnboardingPipelineWorkflow",
      "--task-queue", "alfred-learn",
      "--workflow-id", workflowId,
      "--input", JSON.stringify(onboardingInput),
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
      // Carry gmail_mode / composio_action forward off onboard.json (the
      // learn pipeline persists them there at first start) so the resumed
      // brief-stage workflow stays on the same Gmail path — never re-derive
      // the mode inside the workflow (#69, Temporal replay-safety).
      const userId = data.user_id ?? "";
      const streamId = data.stream_id ?? "";
      const briefGmailMode =
        data.gmail_mode === "composio" ? "composio" : "google";
      if (userId) {
        const workflowId = `onboarding-${userId}-brief-${Date.now()}`;
        const briefInput: Record<string, unknown> = {
          user_id: userId,
          stream_id: streamId,
          gmail_mode: briefGmailMode,
          // Carry the resume stage EXPLICITLY (#74). The brief stage runs
          // as a fresh OnboardingPipelineWorkflow; without this the
          // workflow re-derived its resume point from onboard.json and
          // could not express "resume past awaiting_verification" — it
          // restarted from metadata and the brief stage never ran.
          // OnboardingPipelineWorkflow trusts resume_stage when it is a
          // STAGE_ORDER member and resumes at exactly that stage.
          resume_stage: "brief",
        };
        if (
          briefGmailMode === "composio" &&
          typeof data.composio_action === "string"
        ) {
          briefInput.composio_action = data.composio_action;
        }
        try {
          await dockerExec("temporal", [
            "temporal", "workflow", "start",
            "--type", "OnboardingPipelineWorkflow",
            "--task-queue", "alfred-learn",
            "--workflow-id", workflowId,
            "--input", JSON.stringify(briefInput),
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
  //
  // For chore schedules (schedule_id starts with `chore-`), this also updates
  // the vault chore record's frontmatter `schedule:` field atomically, so the
  // vault and Temporal can never drift after a successful call. Before #144
  // callers had to issue a second PATCH against the chore record themselves;
  // most callers forgot, leaving the audit script (which reads vault FM, not
  // Temporal) showing the old cron. See #478.
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
    //
    // Temporal's describe output shape for `input` is NOT a bare array — it's
    // an envelope: { payloads: [{ metadata: {encoding: "<b64>"}, data: "<b64>" }] }.
    // The old code tested `Array.isArray(input)` which always fails on this
    // object shape, so the --input flag never made it to `schedule create` and
    // rewritten schedules lost their workflow args (see #482).
    //
    // Decode the first payload's base64 `data` field as JSON — that's the
    // single positional arg the workflow receives.
    const inputJson = _extractCurrentInput(startWorkflow);

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

    // 4. Atomically update the vault chore record's frontmatter `schedule:`
    //    field if this is a chore schedule. Pre-#144 the rewrite-cron caller
    //    was responsible for issuing a separate PATCH against
    //    /api/v1/vault/records/chore/<slug>.md to update the FM; if they
    //    forgot, the audit script (which reads vault FM, not Temporal) saw
    //    the stale cron and flagged the chore as still broken. Now we do
    //    both updates here so callers can't half-apply the fix.
    //
    //    If Temporal succeeded but the vault FM update fails, we surface a
    //    500 with `partial_state: true` and details about which side is
    //    authoritative — caller must retry to converge.
    const vaultUpdate = _maybeUpdateChoreFrontmatterSchedule(schId, newCron);
    if (vaultUpdate.attempted && !vaultUpdate.ok) {
      console.error(
        `[rewrite-cron] PARTIAL STATE on ${schId}: Temporal updated to "${newCron}" but vault FM update failed: ${vaultUpdate.error}`,
      );
      throw new ApiError(
        500,
        "PARTIAL_STATE",
        `Schedule ${schId} updated in Temporal to "${newCron}" but vault chore frontmatter update FAILED — vault and Temporal are now divergent. Retry the same call to converge.`,
        {
          partial_state: true,
          temporal_updated: true,
          vault_updated: false,
          new_cron: newCron,
          schedule_id: schId,
          vault_path: vaultUpdate.vaultPath,
          vault_error: vaultUpdate.error,
        },
      );
    }

    sendJson(res, 200, {
      message: "Schedule rewritten",
      schedule_id: schId,
      old_cron_replaced: true,
      new_cron: newCron,
      workflow_type: workflowType,
      temporal_updated: true,
      // `vault_updated` reflects "did we successfully touch the vault FM in
      // this call" — false for non-chore schedules and for chore schedules
      // whose vault record is missing. `vault_skip_reason` carries the
      // explanation when false, so callers (and the audit script) can tell
      // whether to escalate.
      vault_updated: vaultUpdate.attempted && vaultUpdate.ok,
      vault_skip_reason: vaultUpdate.skipReason,
      vault_path: vaultUpdate.vaultPath,
      raw: createOut.trim() || undefined,
    });
  });
}

/**
 * Atomic companion to the rewrite-cron Temporal flow. If schId looks like a
 * chore schedule (`chore-<slug>`) and a vault chore record exists at
 * /mnt/encrypted/vault/chore/<slug>.md, rewrite the frontmatter `schedule:`
 * line in place to match newCron.
 *
 * Returns:
 *   { attempted: false, ok: true, skipReason }  — not a chore schedule, or no
 *                                                  vault record exists. Treat
 *                                                  as success (Temporal-only).
 *   { attempted: true,  ok: true,  vaultPath }  — FM rewritten successfully.
 *   { attempted: true,  ok: false, error,
 *     vaultPath }                                — write or read failed. Caller
 *                                                  must surface 500.
 *
 * Idempotent: rewriting the same cron twice in a row leaves the file in the
 * same state.
 */
export function _maybeUpdateChoreFrontmatterSchedule(
  schId: string,
  newCron: string,
): {
  attempted: boolean;
  ok: boolean;
  vaultPath?: string;
  skipReason?: string;
  error?: string;
} {
  if (!schId.startsWith("chore-")) {
    return { attempted: false, ok: true, skipReason: "schedule_id is not a chore schedule" };
  }
  const slug = schId.slice("chore-".length);
  if (!slug || !/^[a-z0-9][a-z0-9-]*[a-z0-9]?$/.test(slug)) {
    return { attempted: false, ok: true, skipReason: `derived slug "${slug}" is not a valid chore slug` };
  }
  const vaultPath = path.join(CHORE_RECORD_DIR, `${slug}.md`);
  if (!fs.existsSync(vaultPath)) {
    return {
      attempted: false,
      ok: true,
      vaultPath,
      skipReason: `no vault chore record at ${vaultPath}`,
    };
  }
  try {
    const content = fs.readFileSync(vaultPath, "utf-8");
    if (!content.startsWith("---")) {
      return {
        attempted: true,
        ok: false,
        vaultPath,
        error: `vault record at ${vaultPath} has no frontmatter block`,
      };
    }
    const fmEnd = content.indexOf("\n---", 3);
    if (fmEnd === -1) {
      return {
        attempted: true,
        ok: false,
        vaultPath,
        error: `vault record at ${vaultPath} has unterminated frontmatter block`,
      };
    }
    const fmBlock = content.slice(0, fmEnd);
    const rest = content.slice(fmEnd);
    // YAML-safe single-quoted scalar — must mirror chores.ts's yamlScalarQuote.
    const quoted = `'${newCron.replace(/'/g, "''")}'`;
    let updatedFm: string;
    if (/^schedule:\s*.*$/m.test(fmBlock)) {
      updatedFm = fmBlock.replace(/^schedule:\s*.*$/m, `schedule: ${quoted}`);
    } else {
      // No existing schedule line — append one just before the closing fence.
      // This shouldn't happen for a real chore record, but it's safer to
      // insert than silently leave the FM stale.
      updatedFm = fmBlock + `\nschedule: ${quoted}`;
    }
    if (updatedFm === fmBlock) {
      // Idempotent no-op: the schedule line was already correct. Treat as a
      // successful update so callers see vault_updated: true and don't retry.
      return { attempted: true, ok: true, vaultPath };
    }
    fs.writeFileSync(vaultPath, updatedFm + rest, "utf-8");
    return { attempted: true, ok: true, vaultPath };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      vaultPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function _extractCurrentInput(startWorkflow: any): string | undefined {
  // Decode Temporal's describe payload envelope into the raw JSON arg the
  // schedule was originally created with. The CLI's describe output puts
  // args under startWorkflow.input.payloads[].data (base64-encoded JSON).
  // We support the older startWorkflow.args shape as a fallback for any
  // non-Temporal origin describes, but 1.27+ consistently uses payloads.
  const envelope = startWorkflow?.input;
  const payloads = Array.isArray(envelope?.payloads) ? envelope.payloads : null;
  if (payloads && payloads.length > 0) {
    const first = payloads[0];
    const data: unknown = first?.data;
    if (typeof data === "string" && data.length > 0) {
      try {
        const raw = Buffer.from(data, "base64").toString("utf-8");
        // Validate it parses so we don't inject garbage on `create --input`.
        JSON.parse(raw);
        return raw;
      } catch {
        // Fall through — return undefined rather than pass unparseable json.
      }
    }
  }
  // Fallback: legacy `args` shape.
  const args = startWorkflow?.args;
  if (Array.isArray(args) && args.length > 0) {
    try {
      return JSON.stringify(args[0]);
    } catch {
      return undefined;
    }
  }
  return undefined;
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
