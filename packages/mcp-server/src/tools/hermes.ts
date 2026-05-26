// Hermes MCP tool catalogue (the 6th MCP server, alongside alfred / sure /
// plane / vaultwarden / execute).
//
// Sir's design (2026-05-26): the voice agent has 5 MCP servers for Sir's
// world (vault / finances / projects / secrets / third-party apps); it
// needs a 6th for the runtime itself — scheduling, delegation, model
// selection. The other 5 MCP servers all proxy through ctrl-api; this
// one follows the same pattern. ctrl-api's `/api/v1/hermes/*` routes
// (added in packages/ctrl/src/api/routes/hermes.ts) are the backend.
//
// Two transports under the hood (transparent to the tool caller):
//   * HTTP — runs / models / health. ctrl-api fetches hermes:18789 (main)
//     or :18790 (workers) with the per-profile API key.
//   * docker exec — cron. Hermes' /v1/* HTTP API doesn't expose cron;
//     the `hermes cron {list,create,remove}` CLI is the contract.
//
// Profile model: every tool accepts an optional `profile: "main" | "workers"`
// with sensible defaults — agents don't normally specify it. Defaults:
//   run / stop_run    → workers   (background, won't compete with main chat)
//   schedule          → main      (fires into a user-facing channel)
//   health / models   → main      (workers is symmetric; main is canonical)
//
// Descriptions are written for the model on the other end of the connector —
// what to call, when to call it, what NOT to do. See
// packages/hermes/workspace-template/skills/alfred-hermes-operations/SKILL.md
// for the higher-level skill that teaches the agent when to reach for this
// server vs the other five.

import { z } from "zod";
import type { ToolDef } from "./types.js";

// Shared profile schema fragment (kept identical across all 7 tools so the
// model learns one rule). Hermes' two profiles bind separate API ports +
// have separate cron stores, so a tool call MUST pick one even when the
// default is fine.
const ProfileSchema = z
  .enum(["main", "workers"])
  .optional()
  .describe(
    "Hermes profile to target. `main` runs Sir's user-facing channels (Telegram/Slack/email/voice); `workers` runs background tasks. Omit to use the tool's sensible default: run/stop_run default to `workers`, schedule defaults to `main`, health/models default to `main`.",
  );

export const ALL_HERMES_TOOLS: ToolDef[] = [
  // ─── Runtime calls (HTTP path) ─────────────────────────────────────────

  {
    name: "run",
    description:
      "Spawn a Hermes run with a prompt and optional return-channel. Use this to **delegate background work to Alfred-the-text-agent** — research, long-form composition, multi-step tool chains — instead of doing it inside a phone call where the model is voice-tuned and time-bound. Returns immediately with a `run_id`; the run executes asynchronously and (if `return_via` is set) posts its result back via the named channel when complete. Defaults to the `workers` profile so it doesn't compete with Sir's live chat sessions on `main`. **When to call:** Sir says \"research X and email me the summary\" / \"figure out Y and tell me when you're done\" / \"prepare Z by tonight\". **When NOT to call:** Sir wants an immediate answer on this call (just use the other MCP tools directly). Set `return_via.channel` to one of `telegram` / `slack` / `email` / `voice`; `chat_id` is optional and defaults to Sir's primary on that channel. Pre-reqs: write a clear, self-contained prompt — the spawned run won't have your conversation context unless you put it in `prompt`.",
    inputSchema: z.object({
      prompt: z
        .string()
        .min(1)
        .describe(
          "The full task. Make it self-contained — the spawned run has no shared context with you. Include all relevant facts (deadlines, recipients, formats) in the prompt itself.",
        ),
      profile: ProfileSchema,
      model: z
        .string()
        .optional()
        .describe(
          "Override the profile's default model (e.g. `claude-opus-4-5` for research; `claude-haiku-4-5` for cheap routing). Omit to use the profile's configured default.",
        ),
      return_via: z
        .object({
          channel: z
            .enum(["telegram", "slack", "voice", "email"])
            .describe(
              "Where to deliver the run's result on completion. The run picks up this channel from the prompt's trailing instruction.",
            ),
          chat_id: z
            .string()
            .optional()
            .describe(
              "Channel-specific recipient ID. Optional — defaults to Sir's primary on that channel.",
            ),
        })
        .optional()
        .describe(
          "Where to deliver the result. Omit for fire-and-forget (Sir will need to call `list_scheduled` to see the run later).",
        ),
      session_id: z
        .string()
        .optional()
        .describe(
          "Attach this run to an existing Hermes session for continuity. Rare — most voice-initiated runs should be fresh sessions.",
        ),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/hermes/runs",
      body: args,
    }),
  },

  {
    name: "stop_run",
    description:
      "Stop a Hermes run by ID. Use when Sir says \"cancel the X you were doing\" or when a run has clearly stalled. Returns 200 even if the run had already completed (idempotent). Defaults to the `workers` profile (matches where `run` defaults to). **DON'T USE this to kill a run mid-progress unless Sir asks** — stopping a run loses its in-flight tool calls and any partial results.",
    inputSchema: z.object({
      run_id: z
        .string()
        .min(1)
        .describe("The `run_id` returned by a prior `run` call."),
      profile: ProfileSchema,
    }),
    buildRequest: ({ run_id, profile }) => ({
      method: "POST",
      path: `/api/v1/hermes/runs/${encodeURIComponent(run_id)}/stop`,
      query: profile ? { profile } : undefined,
    }),
  },

  {
    name: "health",
    description:
      "Liveness probe for a Hermes profile. Returns `{status, platform}`. Use rarely — only when Sir asks \"is Alfred up?\" or \"is the workers thread running?\". For routine status, just try the operation Sir asked for; a 502/503 from any other tool already tells you Hermes is down. Defaults to `main`.",
    inputSchema: z.object({ profile: ProfileSchema }),
    buildRequest: ({ profile }) => ({
      method: "GET",
      path: "/api/v1/hermes/health",
      query: profile ? { profile } : undefined,
    }),
  },

  {
    name: "list_models",
    description:
      "List the models Hermes' profile-as-model registry exposes (OpenAI-API shape — Hermes presents each profile as a `model`). Use this when Sir asks \"what models do you have access to?\" or when you want to pass a specific `model` override to `run`. Defaults to `main`. Cheap, idempotent.",
    inputSchema: z.object({ profile: ProfileSchema }),
    buildRequest: ({ profile }) => ({
      method: "GET",
      path: "/api/v1/hermes/models",
      query: profile ? { profile } : undefined,
    }),
  },

  // ─── Cron / scheduling (CLI-shell path under the hood) ────────────────

  {
    name: "schedule_prompt",
    description:
      "Schedule a prompt to fire later — either once at a specific time, or on a recurring cron schedule. **This is how Sir gets a reminder at 6 a.m.** When the schedule fires, Hermes runs the prompt and delivers the result through the named channel (Telegram by default). **When to call:** Sir says \"remind me at X\" / \"send me a Y at Z\" / \"every morning at 7\". **Time formats:** ISO-8601 (`2026-05-27T06:00:00+02:00`) for a one-shot, or a 5-field cron expression (`0 7 * * *` for every morning at 07:00). Always include the timezone offset for ISO timestamps — Sir is in Budapest (+02:00 summer / +01:00 winter), do NOT default to UTC. **The prompt is what the agent will be asked to do when the schedule fires** — make it self-contained and end-user friendly (\"Sir, here is your morning reminder about X\"), not a system-flavoured note. Defaults to the `main` profile so the result lands in a user-facing channel. Returns the new `job_id`.",
    inputSchema: z.object({
      prompt: z
        .string()
        .min(1)
        .describe(
          "The user-facing text Hermes will deliver when the schedule fires. Write it as Sir's-eye-view: 'Sir, here is your reminder to prep the Makerspace session', NOT 'remind sir about X'.",
        ),
      when: z
        .string()
        .min(1)
        .describe(
          "ISO-8601 timestamp (with timezone offset) for a one-shot, or a 5-field cron expression for recurrence. Examples: '2026-05-27T06:00:00+02:00' fires tomorrow at 6 a.m. Budapest time. '0 7 * * 1-5' fires every weekday at 07:00. NEVER use a naked timestamp without offset — Sir is not in UTC.",
        ),
      channel: z
        .enum(["telegram", "slack", "voice", "email"])
        .optional()
        .describe(
          "Where to deliver the fired prompt. Defaults to `telegram` (Sir's primary async channel). Use `voice` for time-critical reminders Sir said he needs by phone, NOT for routine notifications (calls are disruptive).",
        ),
      chat_id: z
        .string()
        .optional()
        .describe(
          "Channel-specific recipient ID. Optional — defaults to Sir's primary on that channel.",
        ),
      profile: ProfileSchema,
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/hermes/cron",
      body: args,
    }),
  },

  {
    name: "list_scheduled",
    description:
      "List currently-scheduled prompts (cron jobs) for a profile. Use when Sir asks \"what reminders do I have set?\" or \"what's coming up?\" or before scheduling a new one (so you don't double-book). Returns a list of jobs with their `id`, `prompt`, `when` (cron spec or next-fire ISO), and `channel`. Defaults to `main`. Cheap, idempotent.",
    inputSchema: z.object({ profile: ProfileSchema }),
    buildRequest: ({ profile }) => ({
      method: "GET",
      path: "/api/v1/hermes/cron",
      query: profile ? { profile } : undefined,
    }),
  },

  {
    name: "cancel_scheduled",
    description:
      "Cancel a scheduled prompt by `job_id`. Use when Sir says \"cancel that reminder\" or \"never mind, I don't need the X anymore\". Always confirm with Sir before cancelling unless he EXPLICITLY said to. Idempotent — cancelling an already-removed job returns 200 with `ok: true`. Defaults to `main`.",
    inputSchema: z.object({
      job_id: z
        .string()
        .min(1)
        .describe("The job's id from a prior `schedule_prompt` or `list_scheduled` call."),
      profile: ProfileSchema,
    }),
    buildRequest: ({ job_id, profile }) => ({
      method: "DELETE",
      path: `/api/v1/hermes/cron/${encodeURIComponent(job_id)}`,
      query: profile ? { profile } : undefined,
    }),
  },
];
