---
type: task
status: queued # queued | active | blocked | done | cancelled
title:
owner: "alfred" # "alfred" | "human" | agent-id
tier: 2 # 1 (classify) | 2 (synthesis) | 3 (agentic)
agent_id: "learn-clerk"
skill_entry: "" # vault path to skill file
budget_turns: 25
requires_approval: false
initiative: "" # link to project/initiative
source_event: ""
source_instinct: ""
depends_on: []
blocked_by: []
created: "{{date}}"
created_by: "" # judgment | propagation | human | session
priority: medium # low | medium | high | urgent
tags: []
---

# {{title}}

What needs to be done and why.

## Context

Links to relevant records that triggered this task.

## Outcome

Filled in on completion — what was done, any follow-ups created.
