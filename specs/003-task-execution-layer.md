# Spec 003: Task Execution Layer + Triage Rename

**Version:** 0.1
**Date:** 22 March 2026
**Status:** Draft — Design Complete, Ready for Implementation
**Author:** David Szabo-Stuban + Alfred
**Inspiration:** NTP-OS (neoterragroup/ntpos) architecture

---

## Problem Statement

The alfred-learn pipeline can now classify and file incoming content (P1: routing, P2: structuring via Curator). But when something is classified as actionable, nothing executes it. The system files things beautifully, then stops.

Additionally, the current `task` classification type is misnamed — it's really a triage request ("I don't know what this is, help"), not an execution unit.

---

## Goals

1. **Rename** existing `task` classification → `triage` (accurate naming)
2. **Introduce** `task` as a proper execution primitive (NTP-OS-style)
3. **Add** `skill` as a new vault type (reasoning methodology files)
4. **Build** a Task Runner workflow that picks up queued tasks and executes them
5. **Extend** instincts with execution blocks that create tasks
6. **Establish** the propagation pattern: changes → tasks, tasks → execution → changes

---

## Architecture Overview

```
                    ┌─────────────────────────────┐
                    │  Streams / Inbox / Chat      │  Inputs arrive
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │  EventProcessor (existing)   │  Classify via Clerk
                    │  - extract metadata          │  (full tool access)
                    │  - classify → triage/note/   │
                    │    event/conversation/noise   │
                    │  - write vault record         │
                    │  - attempt judgment           │
                    └──────────┬──────────────────┘
                               │
               ┌───────────────┼───────────────────┐
               │               │                   │
        ┌──────▼──────┐ ┌─────▼──────┐    ┌──────▼──────┐
        │  No match   │ │  Instinct  │    │  Instinct   │
        │  (filed     │ │  w/o exec  │    │  w/ exec    │
        │   as-is)    │ │  (route    │    │  (route +   │
        │             │ │   only)    │    │   CREATE    │
        └─────────────┘ └────────────┘    │   TASK)     │
                                          └──────┬──────┘
                                                 │
                                      ┌──────────▼──────────┐
                                      │  Task Runner         │
                                      │  (new Temporal wf)   │
                                      │  - picks up queued   │
                                      │  - assembles context  │
                                      │  - sessions_spawn    │
                                      │  - writes artifacts  │
                                      │  - marks done        │
                                      │  - propagates        │
                                      └──────────────────────┘
```

---

## Part 1: Triage Rename

### What Changes

The word `task` in the classification vocabulary is renamed to `triage`.

**Semantics:**
- `triage` = "I processed this but can't confidently classify or route it. Needs human review."
- `task` (new) = "A concrete unit of work with an owner, a method, and expected output."

### Files to Modify

| File | Change |
|------|--------|
| `packages/learn/src/validators/schema.py` | `VALID_CLASSIFICATION_TYPES`: replace `"task"` with `"triage"` |
| `packages/learn/src/validators/schema.py` | `VALID_VAULT_TYPES`: replace `"task"` with `"triage"`, add `"task"` (new meaning), add `"skill"` |
| `packages/learn/src/activities/clerk.py` | Clerk prompt: update classification options |
| `packages/learn/src/activities/vault.py` | `write_vault_record`: handle `triage` type |
| Curator (`alfred` repo) | `_templates/task.md` → `_templates/triage.md` |
| Curator (`alfred` repo) | Vault folder: ensure `triage/` exists in provisioner |
| `packages/ctrl/src/templates/bootstrap-openclaw.sh.njk` | Add `triage/` and `skill/` to vault folder creation |
| Documentation | Update all references |

### Migration

- Existing vault records with `type: task` → leave as-is (there are 0 on any tenant)
- Template rename: `_templates/task.md` → `_templates/triage.md`
- No data migration needed (empty folders)

---

## Part 2: Task as Execution Primitive

### Task Schema

```yaml
---
type: task
status: queued          # queued | active | blocked | done | cancelled
title: "Research Norman Carriers for prelease assessment"
owner: "alfred"         # "alfred" | "human" | agent-id
tier: 2                 # 1 (classify) | 2 (synthesis) | 3 (agentic)

# Links
initiative: ""          # optional — link to project/initiative
source_event: ""        # what triggered this task (stream event ID or vault path)
source_instinct: ""     # which instinct created this task (vault path)
skill_entry: ""         # skill file to follow (vault path, e.g. "skill/process-invoice.md")

# Execution
agent_id: "learn-clerk" # which OpenClaw agent executes this
budget_turns: 25        # max conversation turns
requires_approval: false # gate before execution
run_after: ""           # don't execute until this datetime (ISO 8601)
recurrence: ""          # if set, recreate after completion (daily, weekly, etc.)

# Dependencies
depends_on: []          # vault paths of prerequisite tasks
blocked_by: []          # active blockers (vault paths)

# Metadata
created: "2026-03-22"
created_by: "judgment"  # judgment | propagation | human | session
priority: medium        # low | medium | high | urgent
tags: []
related: []
---

# Research Norman Carriers

Context about what needs doing and why.

## Outcome

Filled in on completion — what was produced, any follow-up tasks created.
```

### Status Lifecycle

```
queued → active → done
                  active → blocked → active
                  active → cancelled
         any → cancelled
```

### Task Types by Tier

| Tier | Model Class | Tool Access | Budget | Use Case |
|------|------------|-------------|--------|----------|
| 1 | Fast/cheap (free tier) | Read-only | 10 turns | Classification, quick lookup, yes/no |
| 2 | Capable (Qwen 35B) | Read + Write | 25 turns | Read multiple sources, synthesise, produce written output |
| 3 | Full power (Claude/GPT-4) | Everything | 50 turns | Multi-step with tools, research, iteration, external APIs |

### Task Ownership

- `owner: "alfred"` → AI executes autonomously via Task Runner
- `owner: "human"` → Appears in dashboard/briefing for David
- `owner: "<agent-id>"` → Specific OpenClaw agent executes

---

## Part 3: Skill Graph

### What Skills Are

Plain English methodology files that teach the AI *how to approach* a type of work. Skills are the "playbook" — they describe reasoning patterns, not data.

**Key property:** Skills are stable (methodology doesn't change often). Data is dynamic (new contacts, new projects). The skill says "look up the sender's contact record." The contact record has the actual data.

### Skill Schema

```yaml
---
type: skill
title: "Input Processing — Email Routing"
domain: input_processing  # input_processing | execution | propagation | preference | process
tier: 1                    # recommended AI tier for this skill
related:
  - "skill/input-entity-extraction.md"
  - "skill/input-noise-filtering.md"
tags: []
---

# Input Processing — Email Routing

How to figure out what an email relates to.

## Methodology
1. Start with the sender — look up their contact record
2. Check subject and body for project references
3. Combine signals to determine confidence

## Confidence Determination
- Known sender + project reference = HIGH → auto-route
- One strong signal + one weak = MEDIUM → create triage
- No signals = LOW → classify as noise or triage
```

### Initial Skill Files

| Skill | Domain | Tier | Purpose |
|-------|--------|------|---------|
| `skill/index.md` | — | — | Entry point, lists all skills by domain |
| `skill/input-email-routing.md` | input_processing | 1 | How to route incoming emails |
| `skill/input-noise-filtering.md` | input_processing | 1 | What counts as noise |
| `skill/input-entity-extraction.md` | input_processing | 1 | How to extract people/orgs/places |
| `skill/execution-research.md` | execution | 3 | How to research an entity/topic |
| `skill/execution-draft-response.md` | execution | 2 | How to draft a reply |
| `skill/execution-summarize.md` | execution | 2 | How to summarize a document |
| `skill/propagation-task-creation.md` | propagation | 2 | When to create follow-up tasks |
| `skill/preference-david.md` | preference | — | David's communication style, priorities |

Skills are tenant-specific vault content — each tenant's Alfred learns their preferences. Seeded from templates on provisioning.

---

## Part 4: Task Runner Workflow

### New Temporal Workflow: `TaskRunnerWorkflow`

Runs on a schedule (every 2 minutes, like EventProcessor).

```python
@workflow.defn(name="TaskRunnerWorkflow")
class TaskRunnerWorkflow:
    @workflow.run
    async def run(self) -> TaskRunnerResult:
        # 1. Fetch queued tasks (type: task, status: queued, owner: alfred)
        tasks = await workflow.execute_activity(
            fetch_queued_tasks,
            start_to_close_timeout=timedelta(seconds=30),
        )

        for task in tasks:
            # 2. Check prerequisites (depends_on, run_after, requires_approval)
            ready = await workflow.execute_activity(
                check_task_prerequisites,
                args=[task],
                start_to_close_timeout=timedelta(seconds=10),
            )
            if not ready:
                continue

            # 3. Mark active
            await workflow.execute_activity(
                update_task_status,
                args=[task, "active"],
                start_to_close_timeout=timedelta(seconds=10),
            )

            # 4. Assemble context (skill file + initiative + recent observations)
            context = await workflow.execute_activity(
                assemble_task_context,
                args=[task],
                start_to_close_timeout=timedelta(seconds=30),
            )

            # 5. Execute via sessions_spawn
            result = await workflow.execute_activity(
                execute_task,
                args=[task, context],
                start_to_close_timeout=timedelta(seconds=300),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            # 6. Write artifacts to vault
            if result.artifacts:
                await workflow.execute_activity(
                    write_task_artifacts,
                    args=[task, result],
                    start_to_close_timeout=timedelta(seconds=30),
                )

            # 7. Mark done + record outcome
            await workflow.execute_activity(
                complete_task,
                args=[task, result],
                start_to_close_timeout=timedelta(seconds=30),
            )

            # 8. Propagate — create follow-up tasks if needed
            await workflow.execute_activity(
                propagate_task_completion,
                args=[task, result],
                start_to_close_timeout=timedelta(seconds=60),
            )
```

### Activities

| Activity | Purpose |
|----------|---------|
| `fetch_queued_tasks` | Query vault: `type: task, status: queued, owner: alfred` |
| `check_task_prerequisites` | Check `depends_on` (all done?), `run_after` (past?), `requires_approval` (approved?) |
| `update_task_status` | Update task frontmatter status field |
| `assemble_task_context` | Read skill file, initiative, related vault records → build prompt |
| `execute_task` | `sessions_spawn` with assembled prompt, poll `sessions_history` for result |
| `write_task_artifacts` | Write any produced files to vault (under session folder or artifact path) |
| `complete_task` | Mark status=done, write outcome to task body |
| `propagate_task_completion` | Determine if follow-up tasks needed, create them |

---

## Part 5: Instinct Execution Blocks

### Extended Instinct Schema

Instincts currently have `routing_rule` (where to file). Now they also get `execution`:

```yaml
---
type: instinct
status: active
name: "Invoice Processing"
observation_count: 15
confidence_score: 0.82

routing_rule:
  destination_type: process
  destination: "process/invoice-handling"
  process_step: "review"
  assignee: "david"

execution:
  enabled: true
  tier: 2
  agent_id: "learn-clerk"
  skill_entry: "skill/execution-process-invoice.md"
  budget_turns: 25
  requires_approval: false
  task_title_template: "Process invoice: {title}"

signals:
  domain_patterns: ["@billing", "@invoice"]
  keyword_patterns: ["invoice", "payment", "due"]
  input_types: ["email"]
  attachment_patterns: ["*.pdf", "*.xlsx"]
---
```

### How Judgment Creates Tasks

When `attempt_judgment` matches an instinct with an `execution` block:

1. **Route** the file as before (move to destination)
2. **Create** a task record in the vault:
   ```yaml
   type: task
   status: queued
   title: "Process invoice: Modalus February"
   owner: "alfred"
   tier: 2
   agent_id: "learn-clerk"
   skill_entry: "skill/execution-process-invoice.md"
   source_event: "streams/system-inbox/evt-abc123"
   source_instinct: "intuition/instincts/invoice-processing.md"
   budget_turns: 25
   requires_approval: false
   created_by: judgment
   ```
3. **Task Runner** picks it up on next cycle

### Discretion Gate

The `requires_approval` field controls whether the task executes automatically:

| Instinct State | requires_approval | Behavior |
|----------------|-------------------|----------|
| New (<10 observations) | `true` (forced) | Always needs David's OK |
| Established (10-50 obs) | configurable | Default true, David can set false |
| Mature (50+ obs, score >0.75) | configurable | Default false (auto-execute) |

When `requires_approval: true`, the task stays `queued` with a flag. It appears in David's briefing/dashboard. David can approve (status stays queued, `approved: true` added) or reject (status → cancelled).

---

## Part 6: Vault Structure Changes

### Current → Proposed

```
vault/
  # RENAMED
  triage/          ← was: task/ (low-confidence items needing human review)

  # NEW
  skill/           ← reasoning methodology files (how to think)
    index.md
    input-email-routing.md
    input-noise-filtering.md
    execution-research.md
    execution-summarize.md
    preference-david.md

  task/            ← NEW MEANING: execution units (the work queue)
    2026/03/22/    ← date-organized like other records
      process-invoice-modalus-february.md
      research-norman-carriers.md

  # UNCHANGED (keep all existing)
  inbox/           ← raw files land here
  observation/     ← Curator writes observations
  intuition/       ← instincts (routing + now execution rules)
  reflection/      ← periodic reflections
  note/            ← classified notes
  event/           ← classified events
  conversation/    ← classified conversations
  noise/           ← classified noise
  person/          ← entity records
  org/             ← entity records
  session/         ← interactive sessions
  run/             ← process executions
  process/         ← reusable workflows
  project/         ← initiatives/projects
  # ... all others remain
```

### Template Changes

| Template | Action |
|----------|--------|
| `_templates/task.md` | **Rewrite** with new execution-primitive schema |
| `_templates/triage.md` | **New** — copy of old task.md with renamed type |
| `_templates/skill.md` | **New** — skill graph file template |

---

## Part 7: Implementation Plan

### Phase 1: Triage Rename (Non-Breaking)
**Estimated effort:** 2-3 hours

- [ ] 1.1 Update `VALID_CLASSIFICATION_TYPES` in schema.py: `task` → `triage`
- [ ] 1.2 Update `VALID_VAULT_TYPES`: rename + add new types
- [ ] 1.3 Update Clerk prompt: classification options include `triage` not `task`
- [ ] 1.4 Update `write_vault_record`: handle `triage` type → `triage/` folder
- [ ] 1.5 Create `_templates/triage.md` in Curator repo
- [ ] 1.6 Add `triage/` and `skill/` to vault folder creation in provisioner
- [ ] 1.7 Update documentation (CHANGELOG, vault-schema docs)
- [ ] 1.8 Deploy + verify on David's tenant

### Phase 2: Skill Graph Foundation
**Estimated effort:** 2-3 hours

- [ ] 2.1 Create `_templates/skill.md` template
- [ ] 2.2 Create seed skill files for David's tenant:
  - `skill/index.md`
  - `skill/input-noise-filtering.md`
  - `skill/input-entity-extraction.md`
  - `skill/execution-summarize.md`
  - `skill/preference-david.md`
- [ ] 2.3 Add `skill` to `VALID_VAULT_TYPES`
- [ ] 2.4 Ensure qmd indexes `skill/` folder
- [ ] 2.5 Deploy skill seed via provisioner for new tenants

### Phase 3: Task Execution Primitive
**Estimated effort:** 3-4 hours

- [ ] 3.1 Create new `_templates/task.md` with execution-primitive schema
- [ ] 3.2 Add task CRUD endpoints to ctrl-api (`POST/GET/PATCH /api/v1/tasks`)
- [ ] 3.3 Add `task` to `VALID_VAULT_TYPES` (new meaning)
- [ ] 3.4 Implement `fetch_queued_tasks` activity (query vault for queued tasks)
- [ ] 3.5 Implement `check_task_prerequisites` activity
- [ ] 3.6 Implement `update_task_status` activity
- [ ] 3.7 Implement `assemble_task_context` activity
- [ ] 3.8 Implement `execute_task` activity (sessions_spawn + poll)
- [ ] 3.9 Implement `complete_task` activity
- [ ] 3.10 Deploy + verify with manual task creation

### Phase 4: Task Runner Workflow
**Estimated effort:** 3-4 hours

- [ ] 4.1 Create `TaskRunnerWorkflow` in `workflows/task_runner.py`
- [ ] 4.2 Register Temporal schedule (every 2 min)
- [ ] 4.3 Add to worker.py `ALL_WORKFLOWS`
- [ ] 4.4 Implement `write_task_artifacts` activity
- [ ] 4.5 Implement `propagate_task_completion` activity
- [ ] 4.6 E2E test: create task manually → runner picks up → executes → writes output
- [ ] 4.7 Deploy + verify on David's tenant

### Phase 5: Instinct Execution Blocks
**Estimated effort:** 3-4 hours

- [ ] 5.1 Extend instinct schema with `execution` block
- [ ] 5.2 Update `attempt_judgment` to create tasks when execution block present
- [ ] 5.3 Implement discretion gate (requires_approval logic)
- [ ] 5.4 Update instinct template
- [ ] 5.5 Create a test instinct with execution block on David's tenant
- [ ] 5.6 E2E test: inbox file → classify → match instinct → create task → execute → artifact
- [ ] 5.7 Deploy + verify

### Phase 6: Consequentials
**Estimated effort:** 4-6 hours (done)

- [x] 6.1 Add matter + ledger_entry vault types to schema, ctrl-api, provisioner
- [x] 6.2 Rename initiative → matter across task activities and judgment
- [x] 6.3 Implement write_ledger_entry activity (completion records)
- [x] 6.4 Expand propagate_task_completion → evaluate_consequentials (ledger entry, matter resolution, LLM-driven follow-up errands)
- [x] 6.5 Update TaskRunnerWorkflow to use evaluate_consequentials (120s timeout)
- [x] 6.6 Create vault templates for matter.md and ledger_entry.md

---

## Dependencies

| Dependency | Status |
|-----------|--------|
| EventProcessor E2E working | ✅ Done (v0.2.0) |
| Clerk via sessions_spawn with tool access | ✅ Done (v0.2.0) |
| ctrl-api in Docker (reachable from alfred-learn) | ✅ Done (PR #6) |
| Curator pipeline | ✅ Existing (separate alfred repo) |
| DGX Spark Qwen available | ✅ Done (David's tenant) |
| Vault write endpoint accepts raw content | ✅ Done (v0.2.0) |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Qwen 35B not capable enough for Tier 3 tasks | Use OpenClaw model routing — tier 3 can use Claude/GPT-4 via OpenRouter |
| Task Runner creates runaway tasks (propagation loop) | Budget cap per task, max tasks per propagation cycle, circuit breaker |
| Skill files become stale | Include in daily digest: "X skills haven't been referenced in 30 days" |
| requires_approval bottleneck | Mature instincts auto-execute; approval only for new/uncertain patterns |

---

## Success Criteria

1. **Triage rename** deployed without breaking existing tenants
2. **Skills** seeded and indexed by qmd
3. **Task created** by instinct match with execution block
4. **Task executed** autonomously by Task Runner via sessions_spawn
5. **Artifact written** to vault from task execution
6. **Full chain**: inbox file → classify → instinct match → task created → task executed → artifact in vault → task marked done
