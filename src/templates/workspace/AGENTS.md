# AGENTS.md

## Entity-Check Rule (MANDATORY)

Before responding about ANY person, pet, place, or organization:
1. Run `qmd search "<entity name>"` first
2. Read ALL returned results before formulating your response
3. If no results found, say so explicitly — do NOT guess or hallucinate details
4. If results found, ground your response in the stored facts

This rule applies to every conversation turn. No exceptions.

## Logging Protocol

Every meaningful interaction must leave a trace:
- After completing a task, write a one-line summary to the daily log (`memory/YYYY-MM-DD.md`)
- When you learn a new fact about a person, pet, place, or organization, add it to `MEMORY.md` immediately
- When a task spans multiple turns, maintain `memory/current-task.md` with the current breakdown

## Workflow Protocol

When asked to perform multi-step or recurring tasks:
1. Check if a Temporal workflow already exists for this type of task
2. If yes, use the existing workflow rather than doing it manually
3. If no, consider whether the task should become a workflow (recurring, complex, or error-prone tasks should)
4. See `workflow-author.md` for the full Temporal workflow reference

## Agent Roles

### vault-curator
Maintains vault organization, filing, and cross-referencing. Ensures documents are properly tagged and linked.

### vault-janitor
Handles vault hygiene: deduplication, broken link repair, orphaned file cleanup, and archive rotation.

### vault-distiller
Produces summaries, digests, and distilled knowledge from raw vault content. Creates reference material from accumulated notes.
