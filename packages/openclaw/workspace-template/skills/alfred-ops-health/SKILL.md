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

## Endpoints

### Dashboard / health

- **`self endpoint="/api/v1/admin/dashboard"`** — one-shot snapshot: health, containers, vault stats, recent activity. **Start here.**
- **`self endpoint="/api/v1/admin/health"`** — health check across all services. Returns pass/fail per service.
- **`self endpoint="/api/v1/admin/system/info"`** — CPU / memory / disk / uptime.

### Containers + workers

- **`self endpoint="/api/v1/admin/containers"`** — list all Docker containers with status.
- **`self endpoint="/api/v1/admin/containers/{service}/logs"`** — recent logs from a container (e.g. `alfred-learn`, `openclaw`, `ctrl-api`, `temporal`).
- **`self endpoint="/api/v1/workers/status"`** — curator / janitor / distiller / surveyor status with last_run, processed_count, error_count.
- **`self endpoint="/api/v1/workers/restart" method="POST"`** — kick a stuck worker. Confirmed stuck only.
- **`self endpoint="/api/v1/admin/containers/{service}/restart" method="POST"`** — restart a Docker container. **Dangerous — drops in-flight work.**

### Recent activity

- **`self endpoint="/api/v1/admin/activity"`** — recent API activity log.

### Models + credentials

- **`self endpoint="/api/v1/admin/models"`** — available AI models with provider credentials.
- **`self endpoint="/api/v1/admin/credentials"`** — configured provider credentials (masked).

## Service map (so you know what to look at)

| Container | What it does | When to look at its logs |
|---|---|---|
| `alfred-learn` | Python Temporal worker that runs onboarding, chores, learning workflows, reflection, judgment | Chore didn't fire, digest missing, learning not updating |
| `openclaw` | AI gateway — routes agent calls to LLM providers, handles Slack/Telegram/etc channels | DMs not arriving, agent replies delayed, model errors |
| `openclaw-workers` | Background agent runtime — hosts curator/janitor/distiller/surveyor agents | Inbox piling up, vault quality issues, no new observations |
| `ctrl-api` | Tenant HTTP API on `:3100` — the layer between openclaw/alfred-learn and the Docker socket | Any `self` call returning 500, TUI dashboard broken |
| `temporal` | Workflow engine for alfred-learn | Workflows stuck pending, schedule not firing |
| `alfred` (worker) | Vault worker daemons (curator/janitor/distiller/surveyor as python processes) | Inbox not moving, janitor not sweeping |

## Good behavior

1. **Start with the dashboard.** `self endpoint="/api/v1/admin/dashboard"` gives you 80% of the picture in one call.
2. **Never restart without justification.** Every restart interrupts in-flight work. Quote specific symptom + log evidence.
3. **Mask secrets.** The credentials endpoint returns masked values — don't try to un-mask them.
4. **Correlate time.** Dashboard timestamp → schedule cron time → activity log → container logs.
5. **Disk space matters.** If system info shows disk > 90%, flag it.

## Examples

**Sir: "Is everything running?"**
→ `self endpoint="/api/v1/admin/dashboard"` → summarize container states + any unhealthy services.

**Sir: "The Monday digest didn't arrive."**
→ `self endpoint="/api/v1/schedules"` → find the digest → `self endpoint="/api/v1/workflows"` for recent runs → if failed, `self endpoint="/api/v1/workflows/{wfId}"` → `self endpoint="/api/v1/admin/containers/alfred-learn/logs"`.

**Sir: "What model is my Alfred using right now?"**
→ `self endpoint="/api/v1/admin/models"` → report primary model + provider.

**Sir: "Why is the inbox not being processed?"**
→ `self endpoint="/api/v1/workers/status"` → check curator last_run → if stale, `self endpoint="/api/v1/admin/containers/alfred/logs"` → only restart if logs show crash.
