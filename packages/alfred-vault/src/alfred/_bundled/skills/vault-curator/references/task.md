---
type: task
status: todo # todo | active | blocked | done | cancelled
kind: task # task | discussion | reminder
name:
description:
project: # Link to Project (required unless run: is set)
run: # Link to Run (if spawned from a process)
assigned: # Link to Person or "alfred"
due:
priority: medium # low | medium | high | urgent
alfred_instructions:
depends_on: [] # [[prerequisites — other tasks, records]]
blocked_by: [] # [[active blockers]]
related: []
relationships: []
created: "{{date}}"
tags: []
---

# {{title}}

What needs to be done and why.

## Context

Links to relevant records that triggered this task.

## Related
![[related.base#All]]

## Outcome

Filled in on completion — what was done, any follow-ups created.
