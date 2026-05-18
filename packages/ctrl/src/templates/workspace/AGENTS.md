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

## Delegation & Brief-Awareness Protocol (MANDATORY)

Before acting on any delegation from Sir, check what Alfred already knows
and what Alfred is already doing. Acting blindly risks duplicating
in-flight work, re-asking questions the brief has already raised, or
contradicting a state decision recorded ten minutes ago.

1. **Check the most recent brief.** Call `get_briefing` for today's
   `<YYYY-MM-DD>-morning` (or evening). The brief's §Today, §You acted
   on, and §Waiting on you sections are authoritative for what's open
   right now. If the brief named the matter you're touching, your
   action should reference its current_state, not invent a fresh one.
2. **Check pending Desk cards.** Call `list_pending_decisions()` — if
   a card for this matter is already on Sir's desk, do NOT spawn a
   duplicate. Either wait for Sir's call, or use `get_decision` /
   `list_decisions` to verify Sir hasn't already routed it.
3. **Check in-flight delegations.** Call `list_in_flight_agents()` —
   if another exec-* subagent is already working this matter, abort
   and let it complete rather than racing.
4. **Check the state-change audit.** Call `list_state_changes` with
   `target=<matter or task path>` before mutating state — the audit
   shows whether the field was just touched by another writer.
5. **Close the loop after acting.** When you complete a delegation,
   the dispatch path writes a decision record with `outcome_record`
   referencing what you produced. Do not write that yourself; just
   make sure the work is visible (vault record, sent notification,
   etc.) so the closure step has something to point at.

In short: the brief is the principal's mental model. Read it. Pending
cards are the principal's queue. Don't add to it without intent.
In-flight agents are the swarm's hands. Don't step on them.

## Vocabulary

Canonical terms (do NOT use the parenthesised alternatives):

- **signal** (not "observation", "event", "stream item") — every
  inbound message / calendar move / vexa transcript / omi capture
  after extraction.
- **decision** (not "judgment-old", "choice card", "action") — what
  Sir told the system to do, with intent / note / outcome_record.
- **state change** (not "field update", "patch") — any mutation to a
  matter's or task's state-field, written through `state_mutator v2`
  and audited under `event/state-change-*.md`.
- **briefing** (not "digest", "summary") — the morning/evening
  snapshot written by `BriefingWorkflow`.
- **observation / instinct / intuition / reflection / judgment / discretion / clerk** — keep these as-is, they're the canonical names for the intelligence layer (per `packages/learn/CLAUDE.md`).

## Agent Roles

### vault-curator
Maintains vault organization, filing, and cross-referencing. Ensures documents are properly tagged and linked.

### vault-janitor
Handles vault hygiene: deduplication, broken link repair, orphaned file cleanup, and archive rotation.

### vault-distiller
Produces summaries, digests, and distilled knowledge from raw vault content. Creates reference material from accumulated notes.
