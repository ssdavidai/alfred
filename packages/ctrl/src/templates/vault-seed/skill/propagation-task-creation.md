---
type: skill
title: Propagation — Task Creation
domain: propagation
tier: 2
related:
  - "skill/execution-summarize.md"
  - "skill/execution-research.md"
---

# Propagation — Task Creation

When to create follow-up tasks after a change in the vault.

## Create a Task When

### Something Is Now Actionable
A deliverable arrived that needs review. A blocker cleared. An approval is needed.

### Someone Needs to Make a Decision
The situation changed and a human needs to decide how to respond.

### A Follow-Up Is Required by a Deadline
Something was promised by a date. A reporting cadence requires output.

### A Process Pattern Dictates It
- Invoice arrives → create payment processing task
- New contact discovered → create enrichment task
- Document received → create summarization task

## Do NOT Create a Task When

### Pure Information Updates
A record was updated but no one needs to DO anything.

### Tasks That Already Exist
Before creating, check if a similar task is already queued. Do not create duplicates.

### Noise Events
Even if an input was linked to a project, if it changes nothing actionable, no task.

## Task Specification
- Clear action title ("Review invoice from X" not "Follow up")
- An owner ("alfred" or "human")
- Link to initiative/project if applicable
- Context: why this task was created, what triggered it
- Tier assignment for AI tasks (1=classify, 2=synthesis, 3=agentic)
