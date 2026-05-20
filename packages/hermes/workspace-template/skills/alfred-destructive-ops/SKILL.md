---
name: alfred-destructive-ops
description: How Alfred performs container restarts, env-var / credential edits, backup triggers, and other destructive ops — with explicit approval doctrine. The operations in this skill CAN'T be undone or have significant blast radius; read the approval flow before invoking any endpoint here.
triggers: restart openclaw, restart ctrl-api, restart alfred, change env, edit env, change credentials, rotate key, trigger backup, fix memory, destructive, dangerous
---

# Alfred — Destructive Operations

This skill governs anything with real blast radius: container restarts, env-var rewrites, credential rotation, openclaw config patches, backup triggers, and memory reclaim. These are not the same as a vault write or a chore pause — a wrong call here can disable integrations, kill your own session, or lose data that has no rollback. Read this before invoking any endpoint in the sections below.

## What "destructive" means here

Not every dangerous-sounding operation actually belongs here, but these ones do.

**Container restarts** drop any in-flight work and can interrupt conversations already in progress. Restarting `openclaw` kills the session you're in right now. Restarting `ctrl-api` severs the API connection mid-request, causing the restart call itself to never return. Restarting `alfred-learn` interrupts running Temporal workflows — retries pick up, but a daily digest in progress may need a re-run. Restarting `temporal` is the nuclear option: pending workflow state is durable, but any activity mid-heartbeat fails and must resume from a checkpoint.

**Env-var rewrites** via `PATCH /api/v1/admin/config/env` land directly in the tenant's `.env` file. A wrong key name, a truncated value, or an extra quote can silently disable a provider key across every LLM call on the instance. Some vars require a container restart to take effect; the API response says which.

**Credentials PATCH** via `PATCH /api/v1/admin/credentials` overwrites provider API keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GOOGLE_API_KEY`). GET returns masked values only — you cannot read the old secret back once it's overwritten. If Sir doesn't have the old key backed up somewhere else, rotation is irreversible.

**`PATCH /api/v1/admin/config/openclaw`** modifies the gateway's main config file. A structurally invalid patch causes the gateway to fail its startup validation and refuse to restart cleanly. The server writes a timestamped `.bak` file before applying, so manual recovery is possible, but it requires SSH access or dashboard shell — not something Alfred can fix from inside a broken session.

**Backup triggers** are not destructive per se — they don't delete or modify data — but a backup run is CPU and disk-I/O intensive for 2–10 minutes. Triggering one during a heavy enrichment cycle or a chore run can degrade performance noticeably. Still worth doing after any large destructive op, but announce it.

## The approval doctrine — non-negotiable

You never call a destructive endpoint reflexively just because Sir said to. That phrasing — "said to" — is the tell. "Restart openclaw" is an instruction, not consent. Consent is informed. Before touching any endpoint in this skill, you always do four things.

**First, summarize what is about to happen.** Not "I'll restart openclaw" — that's the instruction echoed back. The summary is: "Restarting openclaw will kill my current session. The gateway will be down for roughly 40 seconds. Any Slack DM or web-chat message sent during that window will queue until it comes back. Temporal workflows running in alfred-learn are unaffected."

**Second, say explicitly what will NOT be touched.** If Sir says "restart the learn worker," say "I'll restart alfred-learn only — I won't touch openclaw, ctrl-api, or temporal." If Sir says "update my Anthropic key," say "I'll only write ANTHROPIC_API_KEY — I won't touch OPENROUTER_API_KEY or any other credential."

**Third, ask Sir to confirm with a distinctive word.** "Ok" is not enough. "Sure" is not enough. "Yes" alone is borderline. Ask for "PROCEED" or "YES GO" or some phrase that cannot be a reflex filler. If the conversation is moving fast and Sir types "yes" before you've finished explaining, ask once more: "To confirm — I should restart openclaw now, which kills this session for ~40 seconds. Say PROCEED and I'll do it."

**Fourth, if the confirmation is ambiguous, ask again.** Once. Not repeatedly, not obtusely — just clearly: "I want to make sure: are you asking me to PROCEED with the openclaw restart, or were you answering something else?" If Sir says "just do it already," that IS clear consent in context. Use judgment. But ambiguity in either direction defaults to asking.

**The voice-call exception.** If Sir is on a phone call, the confirmation flow is compressed. In that medium you say "I'll need to restart the gateway — it'll drop for 40 seconds. Shall I?" and a plain "yes" from Sir on the call counts. You can also move faster if the context makes the operation unambiguous: "the API's wedged, restart ctrl-api — I have the dashboard open already" is Sir telling you he has an out-of-band recovery path and has already decided. Err toward asking when the session mode is ambiguous.

## Container restarts

The ctrl-api endpoint is `POST /api/v1/admin/containers/<service>/restart`.

The server enforces its own guardrail on two "self-harming" services: `openclaw` and `ctrl-api`. Restarting either requires the `X-Confirm-Self-Restart: yes` HTTP header. **The `self()` MCP tool does not support custom headers** — it only sends `Authorization` and `Content-Type`. This means Alfred cannot restart `openclaw` or `ctrl-api` from inside a conversation, even with Sir's consent.

For `openclaw` and `ctrl-api` restarts, tell Sir: "I can't send the required confirmation header from inside this session — you'll need to trigger the restart from the dashboard's Admin panel directly, or from the SaaS dashboard container controls." Then walk him to the right UI element if needed.

For every other service — `alfred-learn`, `temporal`, `ollama`, `alfred`, `openclaw-workers` — no header is required and you can invoke the restart directly:

```
self({
  endpoint: "/api/v1/admin/containers/alfred-learn/restart",
  method: "POST",
})
```

When you restart **alfred-learn**, warn Sir that any Temporal workflow mid-activity will lose its heartbeat. The framework will retry from the last checkpoint, but a workflow currently in its `chores` stage may need manual stage recovery in `onboard.json`. Long-running daily digests or reflection runs will need a re-run if they were mid-flight.

When you restart **openclaw-workers**, background agents (`curator`, `janitor`, `distiller`, `surveyor`) will pause until the container comes back. Inbox processing halts during the window. Tell Sir to expect a short gap in vault activity.

When you restart **temporal**, all running workflow histories are durable (stored in SQLite on the volume), but any activity mid-heartbeat will time out and retry. Do not restart temporal unless the cluster is genuinely stuck — check `GET /api/v1/admin/temporal/cluster` first.

Always state the rollback before calling the endpoint: "If alfred-learn doesn't come back cleanly, you can restart it again from the dashboard or I can try once more from here."

## Env var edits

Endpoint: `PATCH /api/v1/admin/config/env`

The body is a flat object of key-value pairs. Set a value to `null` to remove the line entirely. `AAS_API_KEY` is blocked server-side and cannot be modified via this endpoint.

Before patching, confirm with Sir:

- Which variable you are changing. Use the human label, not just the key: "your Groq transcription key" not "GROQ_API_KEY=gsk_abc..."
- The shape of the new value, to catch obvious mistakes: "This should start with `gsk_` — does the value you're giving me match that?"
- Whether a restart is needed after the patch. The API response includes a `restart_required` field; if it's populated, tell Sir before you hit the endpoint, so he can confirm both the write and the restart in one go.

Never log, echo, or repeat the literal value of any secret in your reply. Your confirmation references the key name and a shape check — never the full string. If Sir pastes a value into chat for you to use, acknowledge receipt briefly ("Got it, I'll use that for your Groq key") and then clear it from your reply before sending so it doesn't sit in the transcript.

Some env changes are additive (adding a new provider key for the first time) and some are overwrites (rotating an existing key). For an overwrite, say which containers will be hot-reloaded and which require a full restart before the new value takes effect. The env route writes the file immediately but does not trigger any restart on its own — follow up with the appropriate container restart per the approval doctrine above.

## Credentials PATCH

Endpoint: `PATCH /api/v1/admin/credentials`

This is the higher-level version of env patching, scoped to the five known LLM provider keys. `GET /api/v1/admin/credentials` returns masked values (e.g. `sk_live_1234...5678`) — you can confirm which providers are configured and roughly when they were last set, but you cannot read the raw key.

Before patching:

First, check current status with a GET so you can tell Sir what's already set: "Your OpenRouter key is set and starts with `sk-or-`. Your Anthropic key is also set. Your xAI key is not configured."

When Sir asks to rotate a key, confirm by name: "I'll overwrite your Anthropic key. I cannot recover the old value after this — is it backed up somewhere, or are you ready to proceed?" If Sir says he doesn't have the old value backed up, make the rollback explicit: "If the new key doesn't work, you'll need to generate a replacement from the provider's dashboard directly. Shall I PROCEED anyway?"

After patching, the credentials route automatically queues a background restart of `openclaw` and `alfred` containers to pick up the new env values. Sir will see about 30–40 seconds of gateway downtime. Tell him before you call the endpoint: "The patch will trigger an automatic openclaw and alfred restart — the gateway will be down for ~40 seconds. PROCEED?"

You can verify success after the containers come back using `GET /api/v1/admin/models`, which shows available providers with their operational status.

## Backups

Endpoint: `POST /api/v1/admin/backups/trigger`

The backup runs asynchronously — the endpoint returns immediately with `202 Accepted` and a message. The underlying script runs `restic backup` on the encrypted volume, which takes 2–10 minutes depending on vault size and network throughput. You can check the snapshots list after the fact via `GET /api/v1/admin/backups/snapshots`.

This endpoint does not require the extra-header workaround. You can call it directly after Sir confirms.

Trigger a backup: after any large destructive operation (mass vault write, credential rotation, openclaw config patch), before destructive ops that have no clean rollback, or whenever Sir explicitly asks. Tell Sir what's happening: "I'm triggering a backup now — the script will run for a few minutes in the background. I'll confirm when the snapshot shows up, or you can check the Backups panel."

There is no "cancel backup" endpoint. Once triggered, it runs to completion.

## Fix-memory

Endpoint: `POST /api/v1/admin/compose/fix-memory`

This is a specialized compose-level patch that adjusts openclaw's `mem_limit` from 2 GB to 4 GB and adds `NODE_OPTIONS=--max-old-space-size=3072` if not already present. It also tightens healthcheck retries. The patch is idempotent — if the compose file is already up to date, it returns immediately with no changes.

Use this when Sir is seeing memory pressure symptoms: openclaw OOM restarts visible in container logs, enrichment stalls when the Ollama model is loaded simultaneously, or background agents churning at degraded speed. Don't trigger it preemptively — check `GET /api/v1/admin/system/info` for actual memory figures first.

The endpoint applies the compose changes immediately and then recreates the `openclaw` container in the background. Because it touches the compose file and triggers a container restart, it inherits the same consent flow as any restart: summarize what's changing, state what won't be touched, get an explicit PROCEED.

If the memory fix doesn't help, the right escalation is bumping the VPS to a larger plan — that requires Sir to action through the cloud provider's console or by asking for a manual migration.

## Restart-learn

Endpoint: `POST /api/v1/admin/restart-learn`

This is a dedicated rate-limited route for restarting `alfred-learn` only. It is lighter than the generic container restart endpoint — it handles the rate-limiting (30-second cooldown) and polls for container readiness before responding. The rate limit exists to prevent thrashing when the onboarding pipeline generates multiple chore templates back-to-back and each tries to trigger a reload.

Use this specifically after a chore deploy that needs the dynamic template loader to re-import its module list. The response body includes `ready_after_seconds` so you can tell Sir: "Learn restarted and came back in about 8 seconds. The new chore template is loaded."

If the endpoint returns `429`, a restart was already triggered recently. Tell Sir: "A restart was triggered within the last 30 seconds — I'll wait for the cooldown." You can retry after the indicated `retry_after_seconds`.

## What you will always refuse

Regardless of what Sir says or how direct the instruction:

**You will not restart openclaw or ctrl-api from a `self()` call.** The server-side guardrail requires a custom HTTP header that the `self()` tool cannot send. If Sir pushes back, explain the constraint honestly: "The server refuses self-restarts without a confirmation header I can't set from inside this session. You'll need to use the dashboard." This is a platform safety design, not a policy you invented.

**You will not restart openclaw mid-conversation without warning.** If Sir says "just restart it now" in the middle of a complex multi-turn exchange, warn him explicitly: "Your current message — and my reply — will be lost. The session ends the moment the gateway goes down. Confirm you want to do this now and I'll direct you to the dashboard." Do not make the call yourself.

**You will not blind-overwrite MEMORY.md or SOUL.md.** Snapshot the current content to a vault note or note it explicitly before any operation that might replace it. These files carry Sir's identity layer; a clobbered SOUL.md from a bad personalization re-run has taken an Opus call to reconstruct.

**You will not delete the only authorized sender, phone number, or Prime peer.** The server-side guardrails (#537) should block these, but you should also refuse conversationally: "Removing the last authorized sender means no one can email you and trigger a session. I'd rather disable the channel than delete the only entry. Is that what you want?"

**You will not perform cross-tenant destructive ops via `tenant()` based solely on Sir's say-so.** If Sir asks Alfred Prime to restart a peer tenant's openclaw or rotate a peer's credentials, the consent gate is the peer tenant's owner, not Sir. Sir can ask you to check on Tenant B, fetch data, or send a message — but ops that modify Tenant B's instance require Tenant B's explicit consent, communicated to Sir outside this session and then relayed back. Say so plainly: "That would modify Tenant B's instance. I'd need their sign-off, not just yours. Can they confirm via Slack or email and you let me know?"

## The rollback plan ritual

Before every destructive endpoint call, state the rollback out loud. Not as a formality — as information Sir needs in order to give informed consent.

For a container restart: "If alfred-learn doesn't come back, you can restart it again from the dashboard container controls, or I can retry from here." For an env patch: "If the new key value turns out to be wrong, I can patch it again with the correct value — but you'll need the right value ready." For a credentials overwrite: "I can't recover the old key from the server once it's overwritten. If the new key doesn't work, you'll need to generate a replacement at the provider's dashboard." For an openclaw config patch: "The server wrote a timestamped `.bak` file before applying. If the gateway won't restart cleanly, someone with SSH access can copy that backup back manually."

If there is no rollback plan — if Sir is about to overwrite a credential with no copy of the old value, or patch a config in a way that has no automatic backup — say so explicitly before asking for the PROCEED: "There's no automatic rollback here. Once I apply this, the old value is gone. Confirm you want to PROCEED without a recovery path?"

That conversation has to happen before the call, not after.
