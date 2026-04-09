---
name: alfred-ops-health
description: Inspect the operational health of Sir's Alfred instance — running containers, system info, recent activity, worker status, available models, credentials, and container logs. Use when Sir asks "is everything running", "what model are you on", "show me recent activity", or when a chore or workflow is silently failing and you need to diagnose.
version: "1.0"
metadata:
  openclaw:
    emoji: "🏥"
---

# Alfred — Ops Health

Sir's Alfred instance is a Docker stack running on a dedicated VPS. When something is slow, broken, or behaving unexpectedly, these are the tools that let you look under the hood.

## Tools available to you

### Dashboard / health

- **`ctrl_admin_dashboard`** — one-shot snapshot: health, container states, vault stats, recent activity. This is the first place to look.
- **`ctrl_admin_health`** — runs a health check across all services. Returns pass/fail per service.
- **`ctrl_admin_system_info`** — CPU / memory / disk / uptime for the host.

### Containers + workers

- **`ctrl_admin_containers`** — list all Docker containers with status (running / unhealthy / exited).
- **`ctrl_container_logs`** `{service}` — fetch recent log lines from a given container (e.g. `alfred-learn`, `openclaw`, `ctrl-api`, `temporal`).
- **`ctrl_workers_status`** — status of the vault worker daemons: `curator` (inbox processor), `janitor` (quality sweeper), `distiller` (latent knowledge), `surveyor` (vector clustering). Each reports last_run, processed_count, error_count.
- **`ctrl_workers_restart`** — kick a stuck worker. Don't use unless a worker is confirmed stuck.
- **`ctrl_service_restart`** `{service}` — restart a Docker container. Dangerous — this drops any in-flight work. Only use when Sir explicitly requests it or when a container is definitively wedged.

### Recent activity

- **`ctrl_admin_activity`** — recent activity log from the tenant API: what endpoints were hit, what workflows fired, what errors occurred.

### Models + credentials

- **`ctrl_admin_models`** — list AI models available to agents, with which provider credentials are configured.
- **`ctrl_credentials_list`** — list configured provider credentials (masked). Shows which providers have keys set up (Anthropic, OpenAI, Google, OpenRouter, xAI) and which don't.

## Service map (so you know what to look at)

| Container | What it does | When to look at its logs |
|---|---|---|
| `alfred-learn` | Python Temporal worker that runs onboarding, chores, learning workflows, reflection, judgment | Chore didn't fire, digest missing, learning not updating |
| `openclaw` | AI gateway — routes agent calls to LLM providers, handles Slack/Telegram/etc channels | DMs not arriving, agent replies delayed, model errors |
| `openclaw-workers` | Background agent runtime — hosts curator/janitor/distiller/surveyor agents | Inbox piling up, vault quality issues, no new observations |
| `ctrl-api` | Tenant HTTP API on `:3100` — the layer between openclaw/alfred-learn and the Docker socket | Any ctrl_* tool returning 500, TUI dashboard broken |
| `temporal` | Workflow engine for alfred-learn | Workflows stuck pending, schedule not firing |
| `alfred` (worker) | Vault worker daemons (curator/janitor/distiller/surveyor as python processes) | Inbox not moving, janitor not sweeping |

## Good behavior

1. **Start with the dashboard.** `ctrl_admin_dashboard` gives you 80% of the picture in one call. Only drill down if it shows something off.
2. **Never restart without justification.** Every restart interrupts in-flight work. Quote the specific symptom + log evidence before you act.
3. **Mask secrets when echoing credentials.** `ctrl_credentials_list` returns masked values — don't try to un-mask them or ask Sir to paste the full key.
4. **Correlate time.** When diagnosing "the digest didn't fire", get the dashboard timestamp, check the schedule's expected cron time, check ctrl_admin_activity around that window, THEN look at container logs if you still don't have an answer.
5. **Disk space matters.** If `ctrl_admin_system_info` shows disk > 90%, flag it — this causes silent failures across the whole stack (saw it on staging: 102 dangling Docker images filled a 301GB disk).

## Examples

**Sir: "Is everything running?"**
→ `ctrl_admin_dashboard` → summarize container states + any unhealthy services + recent error count.

**Sir: "The Monday digest didn't arrive."**
→ `ctrl_schedules_list` → find the digest → check its last_run → `ctrl_workflows_list` for recent runs of that workflow type → if failed, `ctrl_workflows_get` the failed run → `ctrl_container_logs` alfred-learn for the time window if the workflow ran at all.

**Sir: "What model is my Alfred using right now?"**
→ `ctrl_admin_models` → report the currently-configured primary model for the `main` agent + which provider credential is backing it.

**Sir: "Disk space OK on the box?"**
→ `ctrl_admin_system_info` → report disk usage; flag if > 80%.

**Sir: "Why is the inbox not being processed?"**
→ `ctrl_workers_status` → check curator last_run and error_count → if stale, `ctrl_container_logs` alfred for error messages → only restart if logs show an unrecoverable crash.
