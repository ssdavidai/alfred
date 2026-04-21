---
name: alfred-chore-management
description: Inspect, trigger, pause, and reason about Sir's scheduled chores. Chores are recurring Temporal workflows with bespoke Python code generated during onboarding. Use whenever Sir asks about what's running on a schedule, wants to manually trigger a chore, pause/unpause one, or check why a chore hasn't produced results.
version: "1.0"
metadata:
  openclaw:
    emoji: "⏰"
---

# Alfred — Chore Management

Chores are Sir's recurring background workflows. Each one is a bespoke Python Temporal workflow generated during onboarding based on Sir's goals, matters, and data sources. They live in the vault as `chore/` records with `generated: true` and a corresponding `.py` file in `/alfred-data/user-chores/`.

## Two layers to a chore

1. **Vault record** (`chore/<slug>.md`) — the user-facing configuration: name, schedule, status, description, run log, quarantine state.
2. **Temporal schedule** — the actual recurring invocation, registered with Temporal. Its ID is `chore-<slug>`.

Both layers must stay in sync. Use the `self` MCP tool to query both sides.

## Endpoints for chore management

### Read

- **`self endpoint="/api/v1/chores"`** — list all chore records, with frontmatter (name, schedule, status, template, quarantine, last_run).
- **`self endpoint="/api/v1/chores/{slug}"`** — read the full chore body, including run log and generated description.
- **`self endpoint="/api/v1/chores/{slug}/source"`** — full generated Python source + dependency audit.
- **`self endpoint="/api/v1/schedules"`** — list all Temporal schedules. Cross-reference with vault records to spot orphans.

### Act

- **`self endpoint="/api/v1/chores" method="POST"`** — create a new chore from scratch. See "Creating a chore" below.
- **`self endpoint="/api/v1/chores/{slug}/trigger" method="POST"`** — manually fire a chore once, out of cycle. Use when Sir says "run the cashflow forecast now".
- **`self endpoint="/api/v1/chores/{slug}/pause" method="POST"`** — pause a chore (both vault record and Temporal schedule).
- **`self endpoint="/api/v1/chores/{slug}/resume" method="POST"`** — resume a paused chore.
- **`self endpoint="/api/v1/chores/{slug}" method="DELETE"`** — remove a chore and its schedule.

## Creating a chore

When Sir asks for a new recurring job ("every morning, tell me what happened overnight", "every Friday summarize the week"), you are expected to design and install it yourself via `POST /api/v1/chores`.

### Body shape

```
{
  "slug": "daily-morning-briefing",            // kebab-case, unique
  "workflow_class_name": "DailyBriefingWorkflow",
  "python_source": "<full .py file>",
  "schedule": "30 4 * * *",                     // 5-field cron
  "name": "Daily morning briefing",            // optional
  "user_facing_description": "...",            // optional, shown in dashboard
  "params": { "preview_only": false },         // optional; chore_slug is auto-added
  "tags": ["morning", "digest"],                // optional
  "overlap_policy": "Skip",                    // optional, default "Skip"
  "restart_worker": true                       // optional, default true
}
```

The endpoint writes three things atomically: the `.py` file under `/alfred-data/user-chores/`, the `chore/<slug>.md` vault record, and the Temporal schedule `chore-<slug>`. On failure it rolls back so you never end up with partial state.

### The three primitives — compose these, don't reinvent

A chore workflow is plain Python plus calls to three generic activities. You don't write new activities per chore; you compose from these.

**`call_self(endpoint, method="GET", body=None, query=None) -> dict`**
The same surface as the `self` MCP tool you use. List matters, read events, write vault records, trigger sessions, read schedules — anything ctrl-api does. `method` is `"GET"` by default; use `"POST"` / `"PATCH"` / `"DELETE"` for writes.

**`call_composio(action, arguments=None) -> dict`**
Execute any Composio action: `GMAIL_SEND_EMAIL`, `GOOGLECALENDAR_CREATE_EVENT`, `NOTION_CREATE_PAGE`, `GITHUB_CREATE_ISSUE`, `SLACK_POST_MESSAGE`, 1000+ more. Check the per-app SKILL.md for action names and argument schemas.

**`spawn_subagent(prompt, agent_id="learn-clerk", timeout_s=300) -> str`**
Fire-and-wait a subagent on openclaw-workers. Only use when the step genuinely needs LLM reasoning — filtering, formatting, aggregating, deduping all stay in the workflow's Python body where they're cheaper and deterministic. The default `learn-clerk` has `self` + composio tools in scope so the subagent can continue working autonomously within the one turn.

**Rule of thumb:** if the step's output can be described as "return this structured data", do it in plain Python with `call_self` / `call_composio`. If the step is "decide what matters" or "write this as a paragraph", use `spawn_subagent`. Put as little logic as possible inside subagents — they are 100× slower and 1000× more expensive than a ctrl-api call.

**Legacy activities.** The manifest also exposes `fetch_financial_events`, `write_matter_digest_via_llm`, `ask_alfred_to_judge_anomalies`, `fetch_matter_events_last_week`, `save_digest_to_vault`, `send_chore_notification`, and others. These are bespoke helpers kept around for existing generated chores. Do NOT use them for new chores — reach for the three primitives instead. Most bespoke LLM activities can be replaced by a well-prompted `spawn_subagent`; most bespoke data activities become a `call_self` + a filter loop. The exception is `send_chore_notification`, which is the sanctioned delivery path and should still be used for the final "deliver to Sir" step (it's also achievable via `call_self` to `/api/v1/notifications`, but the helper does the right formatting).

Fetch the full list with `self endpoint="/api/v1/chore-actions"` before writing Python. If you reference an activity not in the manifest, the validator will reject the source.

### Writing the Python source

The validator enforces:
1. Size < 100KB, valid Python syntax.
2. Only imports from: `__future__`, `dataclasses`, `datetime`, `typing`, `json`, `temporalio.workflow`, `temporalio.common`, `src.workflows.chores._base`, `src.activities.chore_actions`.
3. Module scope: only class defs, function defs, imports, one docstring, `with workflow.unsafe.imports_passed_through():`, and literal constants.
4. Exactly one `@workflow.defn` class with exactly one `@workflow.run` method.
5. No forbidden names: `eval`, `exec`, `open`, `compile`, `__import__`, `getattr`/`setattr`/`delattr`, `globals`/`locals`, `vars`, `dir`, `breakpoint`.
6. No non-deterministic calls at workflow scope: `datetime.now`, `random.*`, `uuid.*`, `time.time`.
7. Every `workflow.execute_activity(<name>, ...)` must reference a name imported from the two allowed modules.

Before submitting, sanity-check the `chore_actions` manifest: `self endpoint="/api/v1/chore-actions"` returns every activity name you're allowed to import plus its `reads`/`writes`/`llm` metadata. If the activity you need isn't in the manifest, you can't use it — fall back to a subagent step or propose a new activity to Sir for platform work.

### Example: "every Friday, summarise my week and email me"

```python
"""Every Friday 17:00 — weekly summary email."""
from __future__ import annotations
from datetime import timedelta
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from src.activities.chore_actions import call_self, call_composio, spawn_subagent


@workflow.defn
class WeeklySummaryEmailWorkflow:
    @workflow.run
    async def run(self, chore_slug: str) -> dict:
        # 1. Structured pull — plain Python, cheap.
        matters = await workflow.execute_activity(
            call_self,
            args=["/api/v1/vault/list/matter", "GET"],
            start_to_close_timeout=timedelta(seconds=30),
        )
        events = await workflow.execute_activity(
            call_self,
            args=["/api/v1/streams/events", "GET", None, {"limit": "200"}],
            start_to_close_timeout=timedelta(seconds=30),
        )

        # 2. LLM reasoning — single subagent call, returns prose.
        body = await workflow.execute_activity(
            spawn_subagent,
            args=[
                f"Summarise this week for Sir. Matters: {matters}. "
                f"Recent events: {events}. Write 4-5 crisp bullets plus one "
                f"headline sentence. Butler tone. Reply with email body only.",
                "learn-clerk",
                300,
            ],
            start_to_close_timeout=timedelta(minutes=6),
        )

        # 3. Delivery — Composio for the actual email send.
        await workflow.execute_activity(
            call_composio,
            args=[
                "GMAIL_SEND_EMAIL",
                {
                    "recipient_email": "sir@example.com",
                    "subject": "Weekly summary",
                    "body": body,
                },
            ],
            start_to_close_timeout=timedelta(seconds=60),
        )
        return {"delivered": True, "bytes": len(body)}
```

Three activity calls. All three are generic. No bespoke `fetch_weekly_events` or `write_weekly_summary_via_llm` needed.

### After creation

- `restart_worker: true` (the default) triggers an alfred-learn restart so the dynamic loader picks up the new template. The first scheduled run then fires normally. If the restart is rate-limited (429), the response includes a `restart_error` and you must call `self endpoint="/api/v1/admin/restart-learn" method="POST"` manually before the first cron tick.
- New chores start with `quarantine: false` — they run live from the first tick. (Onboarding-generated chores go through 3 dry-runs because they're bulk-generated; chores you create on request have been consciously authored, so we skip quarantine.)
- Fire one real run via `self endpoint="/api/v1/chores/{slug}/trigger" method="POST"` to verify before the first scheduled tick.

### Related

- **`self endpoint="/api/v1/workflows"`** — find recently executed workflow runs, including chore runs.
- **`self endpoint="/api/v1/workflows/{wfId}"`** — inspect a specific workflow execution.

## Chore anatomy (what to tell Sir if he asks)

Each chore record frontmatter has:
- `name` — human-readable label
- `template` — the generated Python module name (e.g. `tuesday_cash_flow_forecast`)
- `workflow_class_name` — the Python class (e.g. `TuesdayCashFlowForecastWorkflow`)
- `schedule` — cron expression (e.g. `0 18 * * 2` = every Tuesday 18:00)
- `schedule_id` — Temporal schedule id, prefixed `chore-`
- `status` — `active` | `paused` | `completed`
- `generated: true` — every chore on a user tenant is generated; no stock templates
- `quarantine: true, quarantine_remaining: N` — new chores run in dry-run mode for 3 cycles before going live
- `last_run` — ISO timestamp of most recent successful run
- `user_facing_description` — a plain-English paragraph describing what it does

The body of the record has a `## Run log` section with entries like `- 2026-04-09T18:00:00.000Z: [dry-run] 0 anomalies`.

## Quarantine explained

When onboarding generates a new chore template, the first 3 scheduled runs are marked `[dry-run]`:
- Dry-run: the workflow executes the detection phase but skips notifications + vault writes.
- If all 3 dry-runs complete without error, quarantine clears automatically and the chore goes live.
- If any dry-run errors, the chore is paused pending review.
- If Sir wants to shorten or skip quarantine for a known-good chore, update `quarantine_remaining` via `self endpoint="/api/v1/vault/records/chore/<slug>.md" method="PATCH" body={"set":{"quarantine_remaining":0}}`.

## Good behavior

1. **Always cross-reference chore record and schedule.** Before reporting a chore's status, check both `self endpoint="/api/v1/chores"` (vault) AND `self endpoint="/api/v1/schedules"` (Temporal). Divergence means a bug.
2. **Manual triggers are non-destructive** if the chore is in dry-run mode; noisy if live. Confirm with Sir before triggering a live chore.
3. **Use the chore API for delete** — `self endpoint="/api/v1/chores/{slug}" method="DELETE"` handles both vault record and Temporal schedule cleanup.
4. **Pause > delete.** If Sir wants a chore "off", prefer pausing. It preserves run history.

## Examples

**Sir: "What chores do I have?"**
→ `self endpoint="/api/v1/chores"` → group by status, show name + schedule + last_run for each.

**Sir: "Run the weekly matter digest for NeoTerra now."**
→ `self endpoint="/api/v1/vault/search" query={"grep": "NeoTerra", "type": "chore"}` → confirm slug → `self endpoint="/api/v1/chores/{slug}/trigger" method="POST"`.

**Sir: "Pause the gym nudge until next month."**
→ `self endpoint="/api/v1/chores/gym-and-health-check-in/pause" method="POST"`.

**Sir: "Did the Monday digest fire this week?"**
→ `self endpoint="/api/v1/workflows"` → filter by type → or read the chore record's run log section.
