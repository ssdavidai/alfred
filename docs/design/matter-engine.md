# The Matter Engine

**Status:** design accepted, pre-implementation. **Date:** 2026-09-01.
**Supersedes** the prose-executed mechanics of `alfred-commitment-register` and
`alfred-hours-reconstruction` (the doctrine survives; the substrate changes).
**Builds on** #466 (register capability), #468 (hours capability), #469–#471
(`commitment` as a canonical vault type).

One system, four nouns: **matters → commitments → hours → evidence**. The
matter is the unit of ongoing concern; commitments are the promises inside it
(both directions); hours are the work performed against it; evidence is what
proves both. Everything else in this document is plumbing for those four.

This design was preceded by an audit of four prior generations of the same
idea built outside this repo (a markdown vault, a designed-but-never-run
engine, a live file-based production system, and this repo's shipped skills),
plus two in-repo shadows (a hand-maintained client spreadsheet and the NAR
attention ledger). Every generation converged on the same laws. The Matter
Engine's job is to move those laws from prose into schema and code — **keep
the doctrine, replace the substrate.**

---

## 1. Principles

1. **The vault keeps what the principal reads; the DB keeps what the machine
   computes.** A commitment stays a canonical vault record. Hours, evidence,
   journals, and every aggregate live in `alfred-state.db` (Store 2), behind
   ctrl-api's existing sole-writer discipline.
2. **Projections are generated, never read back.** The register note, the
   timesheet note, any client spreadsheet or statement — all rendered from the
   store. A projection is never authority.
3. **Verbs, not writes.** Every mutation goes through a named verb that
   journals first and **refuses rather than warns**. Where doctrine says
   human-only, the verb enforces it — the machine's ceiling is *propose*.
4. **The LLM does only what only it can do:** notice a commitment in evidence,
   and attribute ambiguous activity to a matter. Interval math, balances,
   state transitions, booking — boring, tested code.
5. **Deprecate by starvation, not surgery.** Nothing existing is deleted in
   this build. The engine stops feeding the old paths; deletion is a separate
   epic once the engine has run clean.

## 2. Non-negotiables carried over (paid-for doctrine)

- **Nothing enters the hours ledger without the principal's explicit
  approval.** A generated proposal is not approval; silence is not approval;
  a "thanks" is not approval. No confidence level auto-accepts.
- **The accepted ledger is the cursor.** Reconstruction windows run from the
  last accepted entry, never from the schedule — a missed run widens the next
  window instead of silently losing a week.
- **Booking order is load-bearing:** ledger append commits before the
  proposal is marked accepted (in the engine: one transaction).
- **Union of intervals.** One timeline across all sources; never sum
  per-source estimates. Episodes split at 30-minute gaps; days round to
  0.25 h after dedup; a day cannot exceed its evidenced span. A missing
  source lowers confidence and is never compensated for.
- **Corrections are the estimator's only teacher.** The principal's figure,
  the original estimate, and the delta are all stored — and, new here,
  actually consumed.
- **Both directions.** A register tracking only the principal's promises is
  a to-do list. `commitment_kind` covers promises made *and* received.
- **since is immutable; chasing is not a field.** Age runs from when the
  promise was made. Reassignment carries age dishonestly — supersede and
  re-mint.
- **"They said no" ≠ "they went silent."** Outcome is an enum
  (`satisfied · declined · countered · withdrawn · lapsed`); neither refusal
  nor silence deletes the row.
- **Contract authority beats timesheet evidence.** A timesheet can quantify a
  variance; it cannot create an obligation. Unapproved overage is capacity
  evidence, never a line item.
- **Aggregates are never stored.** Balance, age, overdue, counts — SQL views
  over the ledger.
- **The reconciliation ritual is not optional.** The weekly human sweep stays;
  its last question — *what did you agree to that never touched any tracked
  channel?* — is unanswerable by design and stays that way.

## 3. Architecture

Two new modules; nothing else moves.

### 3.1 `packages/ctrl/src/register/` — bookkeeping (lane I)

One migration, five tables:

| Table | Purpose |
|---|---|
| `register_event` | Append-only journal. Every verb lands here first (actor, verb, subject, payload). The whole engine is auditable and recomputable from it. |
| `commitment_index` | Read mirror of `commitment/` vault records (slug, matter_ref, kind, state, parties, due, last_verified_at, evidence refs). ctrl-api is already the sole vault writer, so the mirror updates in the same call — no second-writer problem. Rebuildable by full scan. |
| `work_entry` | date · matter_ref · hours · description · `commitment_ref` (nullable) · evidence handles (JSON) · method · confidence · period_id · accepted_at/by · correction_delta · locked_at. |
| `hours_period` | Proposal lifecycle per matter: draft → proposed → accepted/rejected; proposal note path; Desk card ref. Max accepted `period_end` per matter **is** the cursor. |
| `evidence_event` | The unified activity timeline: source · handle · ts_start/ts_end · actors · matter attribution + confidence · kind · summary. Shared by hours, commitment reconcile, and (later) per-matter NAR. |

**Verbs** (HTTP under `/api/v1/register/*`, journal-first, refuse-not-warn):

- Commitments: `mint` (idempotent on source_ref + party + seq; always
  `provenance: proposed` for machine actors) · `amend` · `transition`
  (checked against the state machine; human-only transitions require a
  principal actor) · `supersede` · `audit` (recompute identity + counts,
  report drift).
- Hours: `propose` (learn submits computed entries) · `approve` (Desk hook;
  optional corrected figure, parsed only from an anchored number) ·
  `reject` · `lock` (statement freeze).

**The state machine**, validated in code, mirrored into the alfred-vault
validator, with the canonical list in **one shared fixture** both packages
test against (this kills the current 11-vs-12 documentation drift):

```
Progression: captured → accepted → in_progress → ready_to_deliver
             → delivered_awaiting_acceptance → fulfilled
Holding:     waiting_on_principal · waiting_on_alfred · waiting_on_client · blocked
Terminal:    released · superseded
```

Coarse vault `status` stays the four-value mapping; the vestigial task-shaped
`state` field on commitment records is dropped (one lifecycle field, one
coarse projection of it — never three vocabularies again).

### 3.2 `packages/learn/src/register/` — inference (lane II)

- **Collectors** (deterministic): sessions, meeting transcripts, mail,
  messages, calendar — each read once per window into `evidence_event`
  via ctrl POST (single-writer preserved). Rule-based matter attribution
  first (participants, channels, repos derived from the matter), LLM
  fallback for ambiguous, confidence stored.
- **Interval math** (pure functions): union-of-intervals, 30-minute episode
  clustering, per-day rounding — ported from the skill prose, with the
  skill's worked examples as the test fixtures.
- **Period-close workflow** (weekly per `hours_tracking` matter): build the
  proposal from `evidence_event`, write the human-readable proposal note
  (projection), file the Desk card, call `propose`.
- **Reconcile workflow** (replaces the per-matter scheduled prompts): advance
  `last_verified_at` from evidence, apply machine-ceiling transitions via
  `transition`, regenerate projections.
- **The one real LLM loop:** for each new evidence batch per matter, answer
  three questions against the OPEN set — *does this create a commitment
  (either direction)? does it discharge one? does it modify one?* — and land
  every answer through verbs, always as proposed. A scoring harness gates
  changes to this loop (precision/recall against a hand-verified
  ground-truth month, which already exists from the audited client ledger).

### 3.3 What deliberately does not change

Desk stays the approval surface (`route_decision`'s hours hook calls
`approve` instead of appending markdown). The two skills become thin wrappers
over the verbs. The signal pipeline, instincts, noise gate, chores,
briefings, daybook, NAR, and `state_mutator`'s matter transitions are
untouched. Decisions are explicitly deferred. Credits/balance are deferred
but the seam exists (`work_entry` is signed-capable; matter config accepts an
optional `rate`); chores-managing-commitments later just call the same verbs.

## 4. Phases

| Phase | Scope | Lanes |
|---|---|---|
| **P0 — the store** | Contract fixture + migration + verbs + commitment mirror + import (existing commitment records indexed; the hand-maintained client ledger's accepted rows booked as history; vault-note ledgers parsed). Nothing user-visible changes. | I (+IV for validator enum) |
| **P1 — hours through the store** | Collectors, interval math, period-close workflow, Desk booking via `approve`. Timesheet notes become projections. Runs beside the manual process until **two consecutive weekly cycles agree**; only then is the spreadsheet demoted to a one-way export. | II + I |
| **P2 — commitment inference** | Three-questions loop + reconcile workflow replace the per-matter scheduled prompts (~50 cron entries on the reference tenant collapse into one workflow). Scoring harness in CI. | II |
| **P3 — convergence** | Transcript pipeline mints commitments (today it mislabels them as tasks); matter rollup derives from commitments; NAR gains per-matter attribution from `evidence_event`. Task starvation complete. | II + I + III |

## 5. Blast radius

### Dies at P1
- The markdown-ledger half of `hours_approval.py` (table-row parsing,
  markdown period-dedup, frontmatter acceptance patching) — the anchored
  correction-number parser survives, ported.
- The markdown-append body of `_accept_hours_proposal_if_any` in
  `decision_router.py` — becomes one verb call; its append-before-mark
  choreography becomes a transaction.
- Timesheet notes as authority; the addendum/correction-note pattern; the
  client-side hours-ledger skill bundle and its session-collector script;
  the hand-maintained spreadsheet write flow.

### Dies at P2
- ~50 per-matter scheduled reconciliation prompt jobs (reference tenant).
- The *executed* mechanics of both skills (~900 lines of agent-performed
  sweeps, ID allocation, projection regeneration, read-back ritual) — kept
  as spec text and test fixtures, no longer performed per run.
- Per-run LLM evidence sweeps against external sources — replaced by
  collectors reading each source once.

### Dies at P3 (starvation complete; deletion is a follow-up epic)
- `task_creation.py` (1,254 lines) including the signal→task branch.
- `TaskClosureWatcherWorkflow` + both closure-predicate styles (deterministic
  matchers and the LLM closure clerk) + `archival_sweep.py` (125 lines).
- `auto_task_create_mode` — one of the three autonomy flags dies entirely:
  settings key, Study toggle, env override, worker gating (7 files across
  learn/web/ctrl). §8 of CLAUDE.md drops to two flags.
- The errand-pack half of `packs_opus.py` (2,951 lines total) including the
  4-tier `_resolve_parent_matter_path` resolver (§15.5 becomes history).
- The task half of `matters.ts` (92 task references: `deriveMatterState`,
  `normalizeTaskState`, parent_matter joins) — rollup re-derives from
  commitments.
- The `task` canonical type: template, validator vocabulary, the §15.2
  status-vs-state gotcha, `promote_triage_to_task`, task sections of the
  claude.ai skill bundle.
- Live task records (~2,900 on the reference tenant): open ones get one
  triage pass (promote to commitment or close); closed ones archive.

### Explicitly spared
Signals, instincts, noise gate, Desk, chores, briefings, daybook, NAR,
matter `state_mutator` transitions, decisions (deferred), the vault itself.

**Net effect:** ~2k lines of new, boring, tested code retiring roughly
5–6k lines of prompt-adjacent machinery, one canonical type, one autonomy
flag, ~50 cron jobs, and the recurring token cost of prose-driven
reconciliation.

## 6. Open questions (settle in P0)

1. **Zero-work days:** the client ledger convention omits them; the skill
   doctrine keeps them. One rule must win in `work_entry` (proposal: keep
   zero days in periods, omit in projections).
2. **Mirror rebuild semantics:** full-scan rebuild cadence and drift alarm
   for `commitment_index` vs vault.
3. **NAR naming collision:** the attention ledger's "hours" columns get
   renamed so *hours* means billable work everywhere.
4. **Evidence retention:** `evidence_event` TTL vs the cold archive —
   evidence backing an accepted, locked entry must survive the compactor.

---

*Related reading: `packages/hermes/workspace-template/skills/
alfred-commitment-register/` and `alfred-hours-reconstruction/` (the
doctrine this engine encodes), `packages/ctrl/docs/STORAGE-ARCHITECTURE.md`
(the four-store model), `docs/design/nar-method.md` (the sibling ledger).*
