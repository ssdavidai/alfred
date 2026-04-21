---
name: alfred-chore-authoring
description: Create new chores or edit existing ones on Sir's request. A chore is a recurring (or one-shot) Temporal workflow Sir has asked you to set up. This skill teaches the full lifecycle — design the right pattern (agent-driven vs Python-pipeline), author the workflow, register it, test it, and iterate. Use whenever Sir says "set up a chore to…", "every morning remind me to…", "automate X", or asks you to change an existing chore.
version: "1.0"
metadata:
  openclaw:
    emoji: "🧱"
---

# Alfred — Chore Authoring

Companion skill to `alfred-chore-management` (which covers inspecting, pausing, triggering existing chores). This one is for CREATING and EDITING.

## First rule: pick the right pattern

There are two shapes of chore. Pick per-task, not per-project.

### Pattern A — agent-driven chore

Pattern used by `daily-morning-briefing`. The workflow is a thin Temporal wrapper that, at schedule time, prompts YOU (main Alfred) with a task and an optional skill reference. You do the work in one turn. Your reply auto-delivers to Sir's channel.

**When to use:**
- The work is primarily synthesis, writing, or reasoning (briefings, weekly recaps, pattern checks, "something to tell Sir" output).
- The data sources are things you can fetch via your normal `self`/`composio` tools on-the-fly.
- The output is prose (or formatted structured text) that Sir reads.
- The "logic" lives best as a prompt/skill, not as code.

**Shape:**
1. Write a SKILL.md in `/home/node/.openclaw/workspace/skills/<skill-name>/SKILL.md` that fully documents the gather → reason → deliver loop. Include concrete examples, anti-patterns, and the silence rule if applicable.
2. Write a thin chore Python workflow that calls one activity — `call_self` against `POST /api/v1/agents/main/task` — with a task prompt like "Follow the `<skill-name>` skill precisely. Your reply IS the deliverable." See the `daily_morning_briefing.py` template as the canonical example.
3. Register the chore via `self endpoint="/api/v1/chores" method="POST" body={…}`.
4. Temporal fires the schedule → workflow fires → the endpoint wakes you up → you read the skill → you deliver.

### Pattern B — Python-pipeline chore

Pattern used by `subscription_watcher`, `weekly_matter_digest`. The workflow is multi-step Python: gather, diff, filter, conditionally call the LLM, conditionally notify. The LLM (me, you, or a workers subagent) is consulted only at decision gates.

**When to use:**
- The work is deterministic data processing with a clear if/then structure (diff this week vs last, filter anomalies, alert only above threshold).
- Most ticks should make ZERO LLM calls (cost/latency sensitive).
- The final action is a single-line notification, not prose synthesis.

**Shape:**
1. Write a full chore Python workflow using `workflow.execute_activity` calls to the three generic primitives — `call_self`, `call_composio`, `spawn_subagent` — composed with plain Python between them.
2. Register via `self endpoint="/api/v1/chores" method="POST" body={…}`.

### Decision rule

- "Every morning, synthesize overnight activity and tell me what matters" → Pattern A.
- "Every Friday, summarize the week's wins + blockers per matter" → Pattern A.
- "Every Monday 9am, check for Stripe subscription anomalies and alert if any are suspicious" → Pattern B.
- "Every 10 minutes, poll feed X for new items tagged Y and add to inbox" → Pattern B.

Mixed: "Every morning, gather the data pipeline-style, then ask me to write the prose" → Pattern B with a `spawn_subagent` call at the prose step. Avoid unless you have a concrete reason; Pattern A is simpler.

## Authoring a Pattern A chore (step by step)

### 1. Write the skill

Put it at `/home/node/.openclaw/workspace/skills/<skill-slug>/SKILL.md`. The skill is the CONTRACT — when you're invoked later by the chore runtime, this file is what you read.

Required structure:
- `---` frontmatter with `name`, `description`, `version`, `metadata.openclaw.emoji`.
- One-sentence intent below the H1.
- "Step 1 — Gather" with a table of `self`/`composio` calls + why.
- "Step 2 — Classify/reason" with rules, anti-patterns, wrong/right examples.
- "Step 3 — Write" with voice/tone guardrails. Always "Sir", never first name.
- "Step 4 — Silence rule" if applicable (when to say nothing).
- "Step 5 — Deliver" — usually "your reply IS the delivery; don't call additional send tools".
- A worked example at the end — inputs, your exact output.

Write the skill BEFORE the workflow. The skill is where the behaviour lives.

### 2. Write the thin workflow

Use `daily_morning_briefing.py` as the template. Adapt these fields:

```python
@workflow.defn(name="<ClassName>Workflow")
class <ClassName>Workflow:
    @workflow.run
    async def run(self, input: <ClassName>Input) -> <ClassName>Result:
        ctx = await workflow.execute_activity(load_chore_context, ...)
        if ctx.get("status") != "active":
            return <ClassName>Result(notes="chore not active")
        if is_quarantined(ctx):
            # dry-run path — record + decrement, return early
            ...
        params = ctx.get("params", {}) or {}
        resp = await workflow.execute_activity(
            call_self,
            args=[
                "/api/v1/agents/main/task",
                "POST",
                {
                    "task": "Follow the `<skill-slug>` skill precisely. "
                            "Your reply IS the deliverable.",
                    "channel": params.get("channel") or "last",
                    "announce": not params.get("preview_only", False),
                    "at_seconds": 1,
                },
                None,
            ],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        # record run log + return
```

Hard constraints (enforced by the dynamic-loader validator):
- Imports only from `temporalio.workflow`, `temporalio.common`, `src.workflows.chores._base`, `src.activities.chore_actions`, `dataclasses`, `datetime`, `typing`, `json`.
- Exactly one `@workflow.defn` class with exactly one `@workflow.run` method.
- No forbidden names: `eval`, `exec`, `open`, `compile`, `__import__`, `getattr`/`setattr`/`delattr`, `globals`/`locals`, `vars`, `dir`, `breakpoint`.
- No non-deterministic calls at workflow scope: `datetime.now`, `random.*`, `uuid.*`, `time.time`.
- Every `workflow.execute_activity(<name>, …)` must reference a name imported from the allowed modules.

### 3. Register the chore

`self endpoint="/api/v1/chores" method="POST" body={...}`:

```json
{
  "slug": "weekly-review",
  "workflow_class_name": "WeeklyReviewWorkflow",
  "python_source": "<full .py source as a string>",
  "schedule": "0 17 * * 5",
  "name": "Weekly review",
  "user_facing_description": "Every Friday 5pm, Alfred synthesises the week.",
  "params": {"preview_only": false},
  "tags": ["weekly", "review"]
}
```

Endpoint atomic flow: writes the `.py` to `/alfred-data/user-chores/`, creates the vault `chore/<slug>.md` record, creates the Temporal schedule `chore-<slug>`, restarts alfred-learn to pick up the new template. Rollback on any failure.

### 4. Test before the first scheduled tick

- `self endpoint="/api/v1/chores/<slug>/trigger" method="POST"` — fires the workflow once out-of-cycle.
- Watch for completion via `self endpoint="/api/v1/workflows"` (last run on the workflow type).
- Sir should see the delivery on his channel. If not, inspect the chore run with `self endpoint="/api/v1/chores/<slug>"` to read the `## Run log` section.

## Authoring a Pattern B chore

Same `POST /api/v1/chores` registration. The difference is the Python source — instead of one thin `call_self` to the agent-task endpoint, compose from the generic activities:

```python
with workflow.unsafe.imports_passed_through():
    from src.workflows.chores._base import (
        load_chore_context, is_quarantined, record_chore_run,
    )
    from src.activities.chore_actions import (
        call_self, call_composio, spawn_subagent,
    )
```

Then inside `run`:
1. `call_self` to fetch data from ctrl-api (events, tasks, matters, integration dispatches).
2. Plain Python to filter/diff/aggregate.
3. `call_composio` for any third-party action (Gmail send, GitHub PR, Stripe query).
4. `spawn_subagent` ONLY for the judgement step (if any) — never for straightforward formatting.
5. `call_self` to `/api/v1/notifications` to deliver.

Run `self endpoint="/api/v1/chore-actions"` to see every activity you're allowed to call with their `reads`/`writes`/`llm` metadata.

## Editing an existing chore

The single endpoint for in-place edits is `PATCH /api/v1/chores/{slug}`. It atomically updates any combination of the workflow source, cron schedule, params, workflow class name, or cosmetic fields. Preserves the slug, schedule id, run-log history, and quarantine state.

```
self endpoint="/api/v1/chores/{slug}" method="PATCH" body={
  "python_source": "<full .py source>",           // optional
  "schedule":      "0 18 * * 5",                   // optional, rewrites the Temporal schedule
  "params":        {"preview_only": false, ...},   // optional, replaces params JSON
  "workflow_class_name": "NewNameWorkflow",       // optional, only with python_source
  "name":          "Weekly review (v2)",          // optional
  "user_facing_description": "...",               // optional
  "tags":          ["weekly", "review"]            // optional
}
```

Supply at least one field. The endpoint re-validates any new `python_source` with the same static checks POST uses, and rolls back the vault record + `.py` file if the Temporal schedule rewrite fails.

Convenience shortcuts for single-field edits (same effect, different shape):

| Change | Shortcut |
|---|---|
| Pause temporarily | `self endpoint="/api/v1/chores/{slug}/pause" method="POST"` |
| Resume | `self endpoint="/api/v1/chores/{slug}/resume" method="POST"` |
| Fire one run out-of-cycle | `self endpoint="/api/v1/chores/{slug}/trigger" method="POST"` |
| Retire the chore | `self endpoint="/api/v1/chores/{slug}" method="DELETE"` — removes schedule + marks the record completed. |
| Edit the Pattern A SKILL.md | Read `/home/node/.openclaw/workspace/skills/<slug>/SKILL.md` with your `read` tool, rewrite with `write`, save. No restart needed — next invocation reads the new text. Use this for tone tweaks, new anti-patterns, added worked examples — anything that doesn't change WHAT the chore does, only HOW you do it. |

## Good behaviour

1. **Always write the skill / prose spec first.** The skill is the contract. Writing the thin Temporal glue before the skill means you'll hack the skill to fit code instead of writing the behaviour you actually want.
2. **Use Pattern A by default for "Alfred says something to Sir" chores.** It's simpler, cheaper, uses your actual voice, and lets Sir tune the behaviour by editing text.
3. **Use Pattern B when deterministic logic or cost matters.** A watcher that runs 2016 times per week should not invoke you 2016 times per week.
4. **Confirm with Sir BEFORE registering.** Show him the cron expression in plain English ("every Friday at 5pm Budapest time, ok?"), the skill's intent, and the expected delivery channel. A chore is a promise to do something forever — over-commit is worse than no chore.
5. **Fire one manual test trigger after registering.** The first real scheduled run should never be the first time the chore has actually executed. Trigger once, confirm Sir sees what he expected, then leave it.
6. **Never auto-register a recurring chore without Sir's explicit ask.** If you notice a pattern worth automating, propose it in conversation. Don't just build it.

## Examples

**Sir: "Set up a daily 5pm recap of what I got done today."**
→ Pattern A. Draft `alfred-daily-recap` skill (gather via `self` events + vault activity, synthesise in butler voice, deliver). Confirm cadence "daily 17:00 Europe/Budapest, via your main Slack?". Write skill + thin workflow. `POST /api/v1/chores` with cron `0 17 * * *`. Trigger once. Done.

**Sir: "Every Monday morning, check if any of my Stripe customers downgraded over the weekend and flag anything suspicious."**
→ Pattern B. Composio GMAIL or STRIPE fetch via `call_composio`, diff against `/alfred-data/chore-snapshots/<slug>.json` with `load/save_subscription_snapshot`-style logic, `spawn_subagent` only when there are suspicious diffs, deliver via `/api/v1/notifications`. `POST /api/v1/chores` with cron `0 9 * * 1`.

**Sir: "Change the morning briefing to fire at 6am instead of 5:30."**
→ `self endpoint="/api/v1/schedules/chore-daily-morning-briefing/rewrite-cron" method="POST" body={"cron":"0 5 * * *"}` (6am Budapest = 05:00 UTC). Confirm with Sir the new time is what he meant.

**Sir: "The briefing is too long, make it shorter."**
→ Read `skills/alfred-daily-briefing/SKILL.md`, tighten the structure section ("2–3 paragraphs" → "1–2 sentences plus a closing line"), save. No code change needed.
