import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { resolveDeliveryTarget } from "../hermes-sessions.js";

const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/mnt/encrypted/openclaw/openclaw.json";

// ---------------------------------------------------------------------------
// Hermes `main`-profile gateway — the native channel-delivery surface.
//
// notify_principal must deliver an agent-initiated message to a *specific*
// recipient on a *specific* channel. Issue #45 settles the mechanism after
// reading the pinned Hermes source (v2026.5.16):
//
//   • `POST /v1/runs` CANNOT deliver. A top-level API run runs on the
//     `api_server` platform, whose toolset (`hermes-api-server` in Hermes'
//     toolsets.py) deliberately EXCLUDES `send_message` — the toolset's own
//     description reads "no interactive UI tools like clarify or
//     send_message". An API run therefore has no way to reach a channel.
//     This answers the ADR-profile-split.md open question definitively:
//     the `/v1/runs` route cannot deliver; the cron route is the answer.
//
//   • Hermes `cronjob` with `deliver` DOES deliver. `cron/scheduler.py`'s
//     `_deliver_result` → `_resolve_delivery_targets` accepts a
//     `"<platform>:<chat_id>"` deliver string and ships the job's final
//     output to that exact platform+recipient via `_send_to_platform` (the
//     same live adapters Telegram/Slack/etc. use). No `send_message` toolset
//     is needed — the Hermes scheduler performs the delivery itself.
//
// So #45's native replacement: create a Hermes cron job on the `main`
// gateway (`http://hermes:18789`) with `deliver=<channel>:<to>`, trigger it
// for immediate execution, poll for the run outcome, then delete it.
//
// The job is created with a far-future recurring schedule + `repeat: 2`
// rather than a one-shot. This is deliberate: a one-shot (`repeat: 1`) job
// is auto-deleted by `cron/jobs.py::mark_job_run` AFTER one run REGARDLESS
// of whether delivery succeeded — and the `last_delivery_error` is lost with
// it. With `repeat: 2` the job survives its first run, so ctrl-api can read
// `last_status` / `last_delivery_error` to report a truthful outcome, then
// delete the job explicitly. The far-future schedule guarantees it never
// fires a second time before we remove it.
//
// The cron HTTP API on the `main` gateway (registered in Hermes'
// `gateway/platforms/api_server.py`):
//   POST   /api/jobs            — create a job
//   POST   /api/jobs/{id}/run   — trigger immediate execution
//   GET    /api/jobs/{id}       — poll status
//   DELETE /api/jobs/{id}       — clean up
// All authenticated with the same Bearer gateway token other
// ctrl-api→Hermes calls use.
//
// ---------------------------------------------------------------------------
// Issue #61 — delivery hardening. Two quality gaps over #45's mechanism:
//
//   Gap 1 — wrap_response cruft (FIXED outside this file). Hermes' cron
//     scheduler wraps every delivered result with a "Cronjob Response: …"
//     header and a "To stop or manage this job…" footer
//     (`cron/scheduler.py::_deliver_result`, v2026.5.16 — `wrap_response`
//     defaults True). `packages/hermes/hermes-config.yaml.njk` now sets
//     `cron.wrap_response: false` in the main-profile block, so the principal
//     sees the message verbatim with no scheduler chrome.
//
//   Gap 2 — non-deterministic echo. The job below wakes an LLM agent and
//     tells it to echo the message verbatim. That is a rephrasing/commentary
//     risk for exact-content notifications. The fully deterministic path
//     would be a Hermes `no_agent` cron job: `cron/scheduler.py::run_job`
//     short-circuits on `job["no_agent"]`, runs `_run_job_script(script)`,
//     and delivers the script's stdout VERBATIM as the final response —
//     genuinely no LLM. We verified against the pinned Hermes source
//     (v2026.5.16) that this path is real. We do NOT use it, for two
//     independently-fatal reasons found in that same source:
//
//       (a) The cron HTTP API cannot create a no_agent job. Hermes'
//           `_handle_create_job` (`gateway/platforms/api_server.py`) forwards
//           a fixed whitelist of fields to `cron.jobs.create_job` —
//           `{prompt, schedule, name, deliver, skills, repeat}`. `no_agent`
//           and `script` are real `create_job()` parameters but are NOT in
//           that whitelist, so a `POST /api/jobs` body carrying them is
//           silently dropped — the job is created as an ordinary agent job.
//           `PATCH /api/jobs/{id}`'s `_UPDATE_ALLOWED_FIELDS` whitelist
//           likewise excludes them. There is no HTTP path to a no_agent job.
//
//       (b) Even if the API accepted it, a no_agent job needs a `script`
//           file that `_run_job_script` resolves under (and validates is
//           inside) `HERMES_HOME/scripts/` — physically inside the `hermes`
//           container. ctrl-api is a SEPARATE container; it cannot write
//           there. This is exactly the cross-container staging problem the
//           #48 cron-execution spike (SPIKE-cron-execution.md, Fact 3.2)
//           documented. Building a file-staging bridge from ctrl-api into the
//           Hermes container is out of scope and a security regression
//           (`hermes` deliberately runs `cap_drop: ALL` + no-new-privileges).
//
//     So #61's Gap 2 takes the hardened-agent-echo path: keep the agent job
//     but constrain the prompt as tightly as a prompt can be (see
//     `hermesCreateDeliveryJob` below). Residual risk: a model can still in
//     principle disobey a prompt; that risk is non-zero but small for a
//     single-turn echo, and is the price of staying within ctrl-api's
//     container boundary. A fully deterministic path would require Hermes to
//     either accept `no_agent`/`script` over its HTTP API or expose an
//     inline-content delivery endpoint — an upstream change, not a
//     ctrl-api one.
// ---------------------------------------------------------------------------

// The main-profile gateway: it owns the six messaging toolsets and the
// channel bindings. Mirrors crossTenant.ts / channelsEmail.ts / phone.ts —
// they all target :18789, never the workers profile.
const GATEWAY_URL =
  process.env.HERMES_GATEWAY_URL ||
  process.env.OPENCLAW_GATEWAY_URL ||
  "http://hermes:18789";

const GATEWAY_TOKEN_PATHS = [
  "/alfred-data/.gateway-token",
  "/mnt/encrypted/alfred/.gateway-token",
  "/app/data/.gateway-token",
];

// Reuse the existing ctrl-api→Hermes token-loading pattern (crossTenant.ts).
function getGatewayToken(): string {
  for (const p of GATEWAY_TOKEN_PATHS) {
    try {
      const token = fs.readFileSync(p, "utf-8").trim();
      if (token) return token;
    } catch { /* try next */ }
  }
  return process.env.HERMES_API_KEY || process.env.OPENCLAW_GATEWAY_TOKEN || "";
}

// Pick the tenant's primary outbound channel. Preference order: slack →
// telegram → webchat. Reads openclaw.json's `channels` map and returns the
// first one that's `enabled: true`. Falls back to "webchat".
function pickPrimaryChannel(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8")) as {
      channels?: Record<string, { enabled?: boolean }>;
    };
    const channels = cfg.channels ?? {};
    for (const name of ["slack", "telegram", "discord", "whatsapp", "webchat"]) {
      if (channels[name]?.enabled) return name;
    }
  } catch {
    // fall through
  }
  return "webchat";
}

// Resolve Sir's recipient id on a given channel from native Hermes session
// data: the most-recently-active gateway session bound to that channel, with
// its delivery target (`origin.chat_id`) — e.g. a Slack channel/IM id or a
// Telegram chat id. Fails soft: returns undefined if nothing found.
//
// Backed by the Hermes gateway session index (`sessions.json`, see
// hermes-sessions.ts), which replaced the retired hermes-shim `sessions_list`
// tool in issue #39. The "notify the principal directly, never a group"
// Telegram rule is preserved inside resolveDeliveryTarget.
function resolveRecipient(channel: string): string | undefined {
  return resolveDeliveryTarget(channel)?.to;
}

interface CronJob {
  id?: string;
  last_status?: string | null;
  last_error?: string | null;
  last_delivery_error?: string | null;
  [k: string]: unknown;
}

/** Create a Hermes cron job that delivers `message` to `channel:to`. */
async function hermesCreateDeliveryJob(
  token: string,
  channel: string,
  to: string,
  message: string,
  urgency: string,
): Promise<string> {
  // The cron agent's *final response* is what Hermes auto-delivers. This is
  // an agent (LLM) job — issue #61 establishes that a fully deterministic
  // `no_agent` script job is NOT reachable from ctrl-api (see the module
  // header, Gap 2). So this path is hardened instead: the prompt is written
  // to constrain the agent as tightly as a prompt can — a single, explicit,
  // non-negotiable copy instruction with a unique sentinel fence so the
  // exact message body is unambiguous even if the message itself contains
  // dashes, backticks, quotes, or its own fences.
  //
  // The sentinel is per-call random so it cannot collide with message
  // content. The agent is told the text BETWEEN the sentinels is the literal
  // payload and that its entire reply must be exactly that payload — nothing
  // before it, nothing after it, the sentinels themselves excluded.
  //
  // The [SILENT] escape hatch is deliberately not offered: this job must
  // deliver. No tools are needed — it is a pure copy task.
  const sentinel = `===ALFRED-NOTIFY-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}===`;
  const prompt = [
    "ROLE: You are a deterministic message-relay job. You are NOT a chat",
    "assistant. A background Alfred process has produced an exact message for",
    "the principal. Your ONLY job is to reproduce that message byte-for-byte.",
    "",
    "RULES — all mandatory, no exceptions:",
    "  1. The payload is the text strictly BETWEEN the two sentinel lines",
    "     below. The sentinel lines themselves are NOT part of the payload.",
    "  2. Your entire final response MUST be exactly that payload — copied",
    "     character-for-character.",
    "  3. Do NOT add a greeting, sign-off, preamble, or trailing remark.",
    "  4. Do NOT summarise, rephrase, translate, correct, reformat, or",
    "     'improve' the payload. Copy it as-is, including any typos,",
    "     punctuation, casing, line breaks, markdown, emoji, or symbols.",
    "  5. Do NOT wrap the payload in quotes or code fences.",
    "  6. Do NOT comment on the task, explain what you are doing, or mention",
    "     that you are relaying a message. Emit ONLY the payload.",
    "  7. Do NOT include the sentinel lines in your response.",
    "  8. Use no tools. This is a pure copy task — there is nothing to look",
    "     up and nothing to decide.",
    "",
    `${sentinel} PAYLOAD BEGINS — copy everything after this line, up to (but not including) the END line`,
    message,
    `${sentinel} PAYLOAD ENDS`,
  ].join("\n");

  // deliver = "<platform>:<chat_id>" — the scheduler resolves this to a
  // concrete delivery target (cron/scheduler.py::_resolve_single_delivery_target).
  const deliver = `${channel}:${to}`;

  // A recurring schedule (kind=interval) with a one-year period: the job
  // survives its first run so we can read the delivery outcome, and the next
  // run is a year out — far beyond the few seconds before we delete it.
  // repeat:2 likewise prevents the post-first-run auto-delete that repeat:1
  // (or a `once` schedule) would trigger.
  const resp = await fetch(`${GATEWAY_URL}/api/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: `notify-principal-${urgency}-${Date.now().toString(36)}`,
      schedule: "every 525600m",
      prompt,
      deliver,
      repeat: 2,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Hermes POST /api/jobs ${resp.status}: ${text.slice(0, 300)}`);
  }
  const created = (await resp.json()) as { job?: CronJob };
  const id = created.job?.id;
  if (!id) {
    throw new Error("Hermes POST /api/jobs did not return a job id");
  }
  return id;
}

/** Trigger immediate execution of a cron job. */
async function hermesTriggerJob(token: string, jobId: string): Promise<void> {
  const resp = await fetch(
    `${GATEWAY_URL}/api/jobs/${encodeURIComponent(jobId)}/run`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Hermes POST /api/jobs/${jobId}/run ${resp.status}: ${text.slice(0, 300)}`,
    );
  }
}

/** Fetch a cron job. Returns null on 404. */
async function hermesGetJob(
  token: string,
  jobId: string,
): Promise<CronJob | null> {
  const resp = await fetch(
    `${GATEWAY_URL}/api/jobs/${encodeURIComponent(jobId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Hermes GET /api/jobs/${jobId} ${resp.status}: ${text.slice(0, 300)}`,
    );
  }
  const body = (await resp.json()) as { job?: CronJob };
  return body.job ?? null;
}

/** Best-effort delete — clean up the delivery job once we have its outcome. */
async function hermesDeleteJob(token: string, jobId: string): Promise<void> {
  try {
    await fetch(`${GATEWAY_URL}/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort — the job will not re-fire for a year even if this fails
  }
}

/**
 * Drive a Hermes cron job to delivery and report the real outcome.
 *
 * The Hermes scheduler runs the job on its next tick and delivers the agent's
 * final output to `channel:to`. We poll `GET /api/jobs/{id}` until the job
 * has run (`last_status` set):
 *   • last_status ok  + no last_delivery_error → delivered
 *   • last_delivery_error set                  → delivery failed (real error)
 *   • last_status error                        → the agent run failed
 *   • timeout                                  → scheduler never ran it
 * The job is deleted in every terminal case.
 */
async function deliverViaCron(
  channel: string,
  to: string,
  message: string,
  urgency: string,
): Promise<{ ok: true; jobId: string } | { ok: false; jobId?: string; error: string }> {
  const token = getGatewayToken();
  if (!token) {
    return { ok: false, error: "Hermes gateway token not available — cannot reach the main-profile gateway" };
  }

  let jobId: string;
  try {
    jobId = await hermesCreateDeliveryJob(token, channel, to, message, urgency);
  } catch (e) {
    return { ok: false, error: `failed to create Hermes delivery job: ${(e as Error).message}` };
  }

  try {
    await hermesTriggerJob(token, jobId);
  } catch (e) {
    await hermesDeleteJob(token, jobId);
    return { ok: false, jobId, error: `failed to trigger Hermes delivery job: ${(e as Error).message}` };
  }

  // Poll for completion. The cron scheduler ticks roughly once a minute and a
  // one-shot delivery agent run is short; 120s of headroom covers a tick plus
  // the run. Tunable for tests via HERMES_NOTIFY_*.
  const pollInterval = Math.max(
    100,
    Number(process.env.HERMES_NOTIFY_POLL_INTERVAL_MS) || 3_000,
  );
  const timeoutMs = Math.max(
    1_000,
    Number(process.env.HERMES_NOTIFY_TIMEOUT_MS) || 120_000,
  );
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    let job: CronJob | null;
    try {
      job = await hermesGetJob(token, jobId);
    } catch {
      continue; // transient — keep polling
    }

    // A repeat:2 job is not auto-deleted after one run; if it is gone, an
    // operator/another process removed it — treat as an inconclusive failure
    // rather than a false "delivered".
    if (job === null) {
      return { ok: false, jobId, error: "Hermes delivery job disappeared before its run outcome could be confirmed" };
    }

    // last_status is null until the scheduler has run the job at least once.
    if (job.last_status != null) {
      await hermesDeleteJob(token, jobId);
      if (job.last_delivery_error) {
        return { ok: false, jobId, error: `Hermes channel delivery failed: ${job.last_delivery_error}` };
      }
      if (job.last_status === "error") {
        return { ok: false, jobId, error: `Hermes delivery job failed: ${job.last_error || "unknown agent error"}` };
      }
      // Ran ok with no delivery error — the message reached the channel.
      return { ok: true, jobId };
    }
    // Not run yet — keep polling.
  }

  // Timed out waiting for the scheduler. Clean up so the job does not linger.
  await hermesDeleteJob(token, jobId);
  return {
    ok: false,
    jobId,
    error: `timed out after ${Math.round(timeoutMs / 1000)}s waiting for the Hermes scheduler to deliver the notification`,
  };
}

export function registerNotificationRoutes(): void {
  // POST /api/v1/notifications — agent-initiated channel notification to Sir.
  // Used by `notify_principal` (MCP) and any platform code pushing to Sir.
  //
  // Body: {
  //   message:  string (required)          — the text Sir sees
  //   channel?: "slack" | "telegram" | …   — defaults to tenant's primary
  //   to?:      channel-specific recipient — auto-resolved if omitted
  //   urgency?: "low" | "normal" | "high"  — tags the cron job name
  // }
  //
  // DELIVERY (issue #45): real channel delivery via a Hermes `main`-profile
  // cron job with `deliver=<channel>:<to>`. See the module header for why
  // this is the verified mechanism and why `/v1/runs` is not. The old
  // hermes-shim `message` no-op (retired in #40) is gone — this path now
  // genuinely puts a message on the channel.
  addRoute("POST", "/api/v1/notifications", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;

    if (!b || typeof b.message !== "string" || !b.message.trim()) {
      throw new ValidationError("message is required");
    }

    const message = b.message as string;
    const urgency = typeof b.urgency === "string" ? b.urgency : "normal";
    const channelHint = typeof b.channel === "string" && b.channel.length > 0
      ? b.channel
      : "auto";

    const channel = channelHint === "auto" ? pickPrimaryChannel() : channelHint;
    const to = typeof b.to === "string" && b.to.length > 0
      ? (b.to as string)
      : resolveRecipient(channel);

    if (!to) {
      sendJson(res, 424, {
        status: "error",
        error: `no recipient on channel=${channel} — pass body.to explicitly or have Sir send at least one inbound message first`,
      });
      return;
    }

    // webchat has no Hermes channel adapter to deliver onto — Hermes' cron
    // `deliver` targets a connected messaging platform. Surface this honestly
    // rather than create a cron job the scheduler can never route.
    if (channel === "webchat") {
      sendJson(res, 424, {
        status: "error",
        error:
          "channel=webchat is not a Hermes-deliverable messaging platform — " +
          "pick a connected channel (slack/telegram/discord/whatsapp/signal) or pass body.channel explicitly",
      });
      return;
    }

    const result = await deliverViaCron(channel, to, message, urgency);

    if (result.ok) {
      sendJson(res, 200, {
        status: "delivered",
        delivered: true,
        channel,
        to,
        urgency,
        jobId: result.jobId,
      });
      return;
    }

    // Real delivery failure — never a silent noop. 502: ctrl-api reached but
    // the downstream Hermes delivery path failed.
    console.error(
      `[notifications] delivery failed — channel=${channel} to=${to} urgency=${urgency}: ${result.error}`,
    );
    sendJson(res, 502, {
      status: "error",
      delivered: false,
      channel,
      to,
      jobId: result.jobId,
      error: result.error,
    });
  });
}
