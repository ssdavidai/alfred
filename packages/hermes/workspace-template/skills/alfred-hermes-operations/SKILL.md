---
name: alfred-hermes-operations
description: Schedule reminders, delegate background work to Alfred-the-text-agent, list scheduled jobs, and inspect Hermes runtime — anything that's about Alfred-the-runtime rather than Sir's vault/calendar/finances. Use whenever Sir asks "remind me…", "research X then tell me…", "what reminders do I have set?", or wants to fire-and-forget a long task on text-mode while you stay on the phone with him.
version: "1.0"
metadata:
  openclaw:
    emoji: "🧠"
---

# 🧠 Alfred — Hermes Operations

Hermes is the runtime Sir's Alfred lives in. The other MCP servers act on Sir's *world* (vault / finances / projects / secrets / third-party apps). This one acts on **the Alfred runtime itself**: scheduling, delegation, model selection, run inspection.

Two Hermes profiles run side-by-side. `main` handles Sir's user-facing channels (Telegram, Slack, email, voice). `workers` runs background tasks. Every tool in this skill takes an optional `profile` parameter with a sensible default — **never specify it unless Sir tells you to**.

## When to reach for this server (vs the others)

- **Sir asks for a reminder** — *"remind me tomorrow at 6 a.m. about X"*, *"every weekday morning, send me a brief about my day"* → `hermes__schedule_prompt`. Never try to set a reminder by writing to the vault or by spawning a long-running run; cron is the right primitive.
- **Sir asks for background work** — *"research these VAT rules and email me a summary tonight"*, *"prepare the presentation deck and let me know when it's done"* → `hermes__run` with `return_via`. The work runs in `workers` while you stay on the phone or close out the conversation.
- **Sir asks what's scheduled** — *"what reminders do I have set?"*, *"is the morning brief still running?"* → `hermes__list_scheduled`.
- **Sir asks to cancel** — *"cancel that 6 a.m. reminder"* → `hermes__cancel_scheduled` (confirm the job_id from `list_scheduled` first; never cancel by guessing).
- **Sir asks about model availability** — *"what model are you running?"*, *"can I use Opus for this?"* → `hermes__list_models`.

## When NOT to reach for this server

- **Vault edits** (update a task, mark a matter done, write a note) — use the `alfred__*` server.
- **Calendar / email / Composio apps** — use `execute__*`.
- **Sure / Plane / Vaultwarden** — use the corresponding `<server>__*`.
- **An immediate one-line answer that doesn't need delegation** — just do it on the call, don't fire a `run`.

## Worked examples

### Reminder
> Sir: *"Remind me tomorrow at 6 a.m. about the Makerspace prep."*

```js
hermes__schedule_prompt({
  prompt: "Sir, here is your morning reminder: review the Makerspace session-1 prep and finalise the presentation.",
  when: "2026-05-27T06:00:00+02:00",
  channel: "telegram",
})
```

**Always include the timezone offset.** Sir is in Budapest (+02:00 in summer, +01:00 in winter — check the current date if you're unsure). A naked timestamp is interpreted as UTC and the reminder fires two hours late.

The prompt should be **Sir-facing** — write what the user receives, not "remind sir about X" (that gets handed to a model that would then send "Reminding Sir about X" instead of the actual reminder).

### Background research
> Sir: *"Research the new Hungarian VAT rules and email me a one-page summary tonight."*

```js
hermes__run({
  prompt: "Research the current VAT changes for the principal's tax jurisdiction — focus on changes affecting small companies and EVs. Produce a one-page summary in plain prose (no markdown bullets) covering: (1) what changed, (2) effective dates, (3) action items for the principal's main operating company. Email the summary to the principal's primary inbox.",
  profile: "workers",
  return_via: { channel: "email" },  // omit chat_id → defaults to the principal's primary on that channel
})
```

Two rules for the prompt:
1. **Self-contained.** The spawned run has no shared context with this conversation — every fact it needs (company name, recipient, format, deadline) must be in the prompt.
2. **End-state oriented.** Tell it what the finished deliverable looks like, not a sequence of steps.

### Recurring brief
> Sir: *"Every weekday morning, send me a quick brief about my day."*

```js
hermes__schedule_prompt({
  prompt: "Sir, your morning brief: read today's calendar, the overnight Telegram digest, and the top three open matters; write a 3–4 sentence summary covering what is on Sir's plate today and which item to start with.",
  when: "0 7 * * 1-5",
  channel: "telegram",
})
```

5-field cron expression — fires at 07:00 every weekday in Hermes' configured timezone.

### Cancel
> Sir: *"Cancel that 6 a.m. reminder I set earlier."*

First confirm what's there:

```js
hermes__list_scheduled({})
```

…then cancel by the id:

```js
hermes__cancel_scheduled({ job_id: "cron-abc123" })
```

Never cancel a job whose prompt you can't preview to Sir; if the list returns more than one matching reminder, ask Sir which.

## Output etiquette

- After `hermes__schedule_prompt` succeeds: *"Done, sir — the reminder is set for tomorrow at six."* (One sentence. No job_id, no timezone offset, no internals.)
- After `hermes__run` returns: *"I've kicked that off, sir. You'll have the summary by email by this evening."*
- If a tool returns an error: surface the gist plainly. Don't invent a reason — the error body says what failed.

## Things to never do

- **Never fabricate confirmation.** If a tool 5xx'd or didn't return success, do NOT tell Sir the reminder was set.
- **Never use UTC for Sir's `when`.** Sir is in Budapest. The voice agent must spell out the offset.
- **Never spawn a `run` to do something the other MCP servers can do in one call.** A `hermes__run` is delegation to a *separate* text agent — it costs an LLM round-trip on the workers profile, and the result lands in some other channel later. Use it for genuine multi-step work, not for "list my open tasks".
- **Never recurse.** Do not fire a `run` whose prompt itself asks the spawned agent to fire more runs — Hermes has a `max_spawn_depth: 1` for a reason.
