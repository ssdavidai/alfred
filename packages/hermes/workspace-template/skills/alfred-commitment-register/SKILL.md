---
name: alfred-commitment-register
description: Build and maintain an evidence-backed commitment register for a matter — every promise made to Sir and every promise Sir made, with its source, state and next action. Use when Sir asks to create/build/stand up a register for a matter, when he asks what he owes anyone or what is owed to him, or when a scheduled reconciliation runs. Activates for matters carrying `commitment_register` in their frontmatter.
version: "1.0"
metadata:
  openclaw:
    emoji: "📋"
---

# Alfred — Commitment register

A commitment is a promise with an accountable party and an evidence handle.
This skill holds every one of them for a matter so Sir never has to reconstruct
who owes what from memory.

**Canonical state lives in `commitment/` vault records.** Notes, Canvases,
dashboards and briefings are projections, regenerated from the records every
run. A projection is never authority, and stale projection prose must never
override a record.

## Switching it on

The matter's frontmatter carries the config. One word is enough:

```yaml
commitment_register: true
```

Everything else is derived:

| Value | Derived from |
|---|---|
| prefix | the matter slug, uppercased and truncated — `acme-engagement` → `ACME` |
| participants | the matter's `related_persons` and `related_orgs` |
| sources | whatever the tenant actually has connected |
| projection | `note/<matter-slug>-commitment-register.md` |
| policy note | `note/<matter-slug>-commitment-management.md` |
| external actions | always forbidden — not a choice |

**`<matter-slug>` is the matter's filename without `.md`. Nothing else.**

Read it off the record's path: `matter/neoterra-ai-consulting-ntpos-build.md`
gives `neoterra-ai-consulting-ntpos-build`. Do **not** derive it by slugifying
the `name` field. A matter's display name drifts — it gets retitled when a
product is renamed — while its filename does not, so the two often disagree.

A live example: a matter whose file is
`matter/neoterra-ai-consulting-ntpos-build.md` carries the name
`NeoTerra AI Consulting Ken Build`. Slugifying the name produced
`...-ken-build-commitment-register.md`, a projection at a path nothing else
would ever look for. The filename is the stable identifier; the name is prose.

Use that one string for the projection path, the policy-note path, and the
`commitment_scope`.

This is not cosmetic. A derived path is only useful if it is *predictable*:
anything that later resolves a register by constructing its path — a rollup, a
digest, the next reconciliation — looks for the slug form. A title-cased
filename is not lost, but it is unaddressable by the rule meant to find it,
and a check that trusts the convention will silently report one fewer register
than exists.

**Verify by constructing the path, not by listing the directory.** After
writing the projection, read it back at the exact derived path. A read-back
that locates the file by any other means passes while the derivation is broken
— which is precisely how this went unnoticed.

Use the object form only to override a derived value that is wrong — a prefix
collision, a participant the matter does not list, a different destination:

```yaml
commitment_register:
  enabled: true
  prefix: ACME
  participants: [...]
  projection: slack:workbench-acme   # opt-in; default is the vault note
```

`enabled: false`, or the key's absence, means this skill does not act on the
matter — so a matter with a bespoke wrapper skill keeps running on it.

**Record the resolved values in the policy note, marking which were derived.**
A later run cannot otherwise distinguish an intentional override from a drifted
default.

## Invocation contract — "create a commitment register"

When Sir says **create**, **build**, **set up** or **stand up** a commitment
register for a matter, that authorises and requires the complete system now —
not a report, not a schema proposal, not a note, and not stopping after the
records:

1. Full initial evidence reconciliation across the available sources.
2. The policy note, from `templates/commitment-policy-note.md`.
3. Canonical `commitment/` records with stable IDs, evidence, states and
   dependencies.
4. The projection — a vault note by default — generated from the records and
   read back.
5. A weekday reconciliation schedule, unless Sir said on-demand only.
6. An immediate end-to-end test of that schedule.

Do not ask whether he wants the projection or the automation after he used that
phrase; they are the product. Ask only when a genuinely irretrievable choice
blocks implementation — two equally plausible matters, or no way to identify
the intended people.

A request to **review**, **summarise**, **inspect** or **reconcile** an
existing register does **not** authorise creating a new destination or
schedule. Follow the existing configuration.

Use `references/bootstrap-verification.md` for the read-back matrix and the
schedule proof standard.

## Before creating anything

1. Search the vault for an existing policy, commitment IDs, records and
   aliases. Search the bare ID stem (`ACME-COM-2026-`), not a quoted-string
   grep — YAML quoting varies and an exact match silently undercounts. Count
   only `type: commitment` records with a valid ID and the expected
   `commitment_scope`.
2. Search existing skills and scheduled jobs so you do not build a duplicate.
3. Read every candidate record before modifying it.
4. Find existing projections and classify each as canonical, private, or
   client-facing.
5. Preserve valid fields and links — patch deltas, never replace wholesale.

## Record contract

One `commitment/` record per commitment:

- `commitment_id` — `<PREFIX>-COM-YYYY-NNN`, allocated sequentially
- `commitment_scope` — the matter slug
- `commitment_kind` — `principal_promise`, `client_request`,
  `internal_request`, or a documented local type
- `commitment_state` — see the lifecycle below
- `requested_by`, `accountable_party`, `next_action`
- `source_type`, `source_ref`, `source_quote`
- `last_verified_at`
- `matter_ref` — `matter/<slug>.md`. Commitments hang off matters; the matter
  is the ongoing concern and the commitments are the promises inside it.
- `depends_on`, `blocked_by`, `blocked_on` where relevant
- `delivery_evidence`, `client_acknowledgement` or equivalent
- tags `commitment` and the matter slug

Optional: `due`, `not_before`, `pending_confirmation`, `acceptance_criteria`,
`released_by`, `release_evidence`, `supersedes`, `superseded_by`,
`projection_visibility`.

When writing raw YAML, **quote any scalar containing `#`, `: `, or brackets** —
otherwise an issue reference like `#319` truncates `next_action` at the comment
marker. Read back and repair before generating the projection.

## Lifecycle

```
captured → accepted → in_progress → ready_to_deliver
         → delivered_awaiting_acceptance → fulfilled
```

Holding: `waiting_on_principal`, `waiting_on_alfred`, `waiting_on_client`,
`blocked`. Terminal exceptions: `released`, `superseded`.

Coarse `status` mapping — the vault's four-value vocabulary:

| `status` | `commitment_state` |
|---|---|
| `todo` | captured, accepted, waiting_on_principal, ready_to_deliver, delivered_awaiting_acceptance |
| `active` | in_progress, or waiting_on_alfred while work executes |
| `blocked` | blocked, or waiting on an external prerequisite |
| `done` | fulfilled, with delivery and acceptance evidence |

`released` and `superseded` keep `status: blocked` or `done` as appropriate and
carry the truth in `commitment_state`. **If the coarse status cannot express
the real state, preserve truth in `commitment_state` — never force a false
closure.**

## Capture rules

1. A commitment needs an obligation, an accountable party, and an evidence
   handle.
2. Brainstorming, possibilities, FYIs and aspirations are not commitments.
3. Ambiguous obligations may be captured with `pending_confirmation: true` —
   and must not be presented as agreed work.
4. Deduplicate by obligation, requester, deliverable, source and outcome.
5. Preserve the source quote faithfully. Never strengthen the wording.
6. **Preparation is not delivery. Delivery is not acceptance.**
7. Close only on delivery evidence plus acceptance, an explicit release, or
   governing-instrument evidence proving nothing is outstanding. Contract-based
   closure cites the clause and is never described as client acceptance.
8. A client-owned prerequisite is a blocker on the record — do not invent a
   phantom record owned by someone outside the system.
9. Scope changes supersede. Preserve the old record; link both directions.
10. Record dependency chains explicitly; detect missing targets and cycles.
11. Before turning any overage, capacity variance, renewal, penalty or payment
    shortfall into a decision for Sir, follow `references/contract-authority.md`.
    A timesheet can quantify a variance; it cannot create an obligation.

## Reconcile

When Sir asks whether commitments were delivered, accepted or paid **in a named
source**, inspect that source directly in the same turn — follow
`references/direct-delivery-evidence.md`. Do not let a stale record body,
session summary or projection override direct source evidence.

For routine reconciliation:

1. Read the policy note and every record for the scope. If the policy still
   demands a retired section or superseded rule, repair that narrow drift and
   read it back first — a stale policy must not reintroduce a layout the
   current format forbids.
2. **Take the oldest active `last_verified_at` as the evidence cutoff.** Not
   the schedule tick, not the calendar.
3. Sweep bounded evidence per `references/bounded-evidence-sweeps.md`. Query a
   conditional source only when its trigger window has opened; record an
   intentional non-query as an exclusion, not as degradation.
4. Classify each evidenced change: new commitment, state transition, blocker
   change, delivery, acknowledgement, release, supersession, **evidence-boundary
   expansion**, or no change.
5. Patch minimal frontmatter, and advance `last_verified_at` only after the
   sweep completes.
6. Read changed records back. Verify ID, state, evidence, next action, tags,
   coarse status, and body/frontmatter agreement.
7. Recompute counts and dependency chains from the records.
8. Generate the projection from the records, then read the written artifact
   back.

### Distinctions the classification depends on

**Evidence-boundary expansion is not a lifecycle transition.** When a new
issue, ticket or defect belongs to the same failure family, intended outcome,
accountable party and acceptance boundary as an existing commitment, enrich
that record's `source_ref`, `next_action` and body — do not create a new
commitment and do not call it a state change. Split it out only when it
introduces a distinct deliverable or acceptance boundary.

**Message timestamps are the boundary, not session start times.** A session
that began before the cutoff may contain a later message proving delivery.

**Exclude the register's own machinery.** Scheduled jobs and dashboard
refreshes that restate register content are not evidence. Repetition by a
projection is not a signal. Inspect the underlying messages when a hit comes
from a scheduled session.

**A newly scheduled meeting is execution context, not a commitment** — surface
it as the next opportunity to resolve existing actions while `Changes since…`
still reads `No evidenced state changes`. *Exception:* when the obligation was
specifically to arrange the meeting, a verified invitation fulfils it. That
proves scheduling only — not acceptance, attendance, or any downstream
commitment.

**Repair every human-readable surface, not just the body.** After a rescope,
due-date move, unblock or transition, audit `description`, title, `next_action`,
`blocked_on`, acceptance text and opening prose in the same pass. A later
corrective appendix does not make an earlier contradictory summary harmless —
dashboards and search previews render the stale field first. Include terminal
records in this audit: a fulfilled commitment may still open with "blocked" or
an executable next action. That is hygiene, not a transition.

**A timeout after requesting a state change is ambiguous, not failed.** Read
the record and its audit trail before retrying; if the transition already
landed, continue from it rather than duplicating the mutation.

### No-change runs

A scheduled run may begin minutes after a prior verified pass. When it does:

- Use the exact oldest-active `last_verified_at`. Do not broaden the window to
  manufacture activity.
- Treat alias hits as candidates, not evidence. Incidental mentions in
  forecasts or unrelated planning do not change state.
- When the bounded sweep completes with no transition, advance
  `last_verified_at` on active records only, read them back, and report
  **reverified / no evidenced change** — not a state change.
- Preserve terminal records unless new evidence directly challenges them.
- A silent-delivery convention applies **after** reconciliation, not instead of
  it. Finish the sweep, advance and read back timestamps, recompute counts,
  regenerate the projection with a fresh marker, read it back — *then* return
  the silent token.
- The run's own maintenance writes are not evidence.

### Overlapping manual and scheduled runs

A manual reconciliation may finish minutes before a scheduled one, or still be
settling when it starts.

1. At the start of the scheduled run, read the records and the current
   projection before choosing the window.
2. If a newer manual run already advanced `last_verified_at` and wrote a
   verified projection, **that is the previous reconciliation**. Use the oldest
   active canonical timestamp as the cutoff; do not replay changes merely
   because they postdate the last scheduler tick.
3. A correction already in the records and the current projection is historical
   state, not a fresh transition.
4. Regenerate from the latest read, never from an earlier in-memory snapshot.
   If the projection marker changes during verification, let the competing
   writer settle, reread, and do one final whole-document replacement.
5. **Never let a scheduled projection overwrite newer canonical truth** with
   the prior day's counts.

### Scheduler self-verification boundary

When the reconciliation is running *inside* the scheduled job whose successful
completion is itself an acceptance criterion, that invocation cannot prove its
own terminal status before it returns.

1. Verify what is observable during the run: record read-back, patches,
   projection write and read-back.
2. Keep the bootstrap commitment open. Reaching the digest step is not
   fulfilment.
3. Narrow its `next_action` to checking the recorded run status next pass.
4. On the next run, inspect the previous execution record first. Close only
   when it is recorded successful with no delivery error.
5. This deferred proof is **not** source degradation — the sweep may be
   complete even though the run cannot attest to itself.

If a source refresh is partial, preserve state and label the reconciliation
`Source refresh degraded: <source>`. **Never guess a transition.**

## Projection

Follow `references/projection-format.md` and
`templates/register-projection.md`. Default destination is
`note/<matter-slug>-commitment-register.md`; Slack is opt-in and adds the
safety requirements in `references/slack-projection.md`.

Replace the whole document unless the destination guarantees safe structured
section updates. Read the artifact back and verify title, sections, first and
highest IDs, the marker and destination identity.

## Deliver

Reply with: counts by actionable state; up to three actions Sir can take now;
what is waiting on others; newly blocked, unblocked, delivered or accepted
items; the projection path; any degraded source.

Keep work blocked behind another decision separate from `needs action now`, so
the headline does not overstate what is executable.

**Reconciliation never sends deliverables, invoices, replies or client
messages.** That needs a separate instruction from Sir and the relevant sending
skill loaded.

## Definition of done

- Policy note exists, was read back, and records the resolved configuration
  with derived values marked.
- Every ID is unique and auditably sequential.
- Every record has scope, kind, state, accountable party, next action,
  `matter_ref` and source evidence.
- Detailed state and coarse status agree; no body contradicts its frontmatter.
- Delivery and acceptance claims have evidence.
- Any commercial-variance decision is grounded in the executed agreement, not
  inferred from a timesheet.
- Dependencies resolve, with no cycle.
- The projection was generated from records and read back — title, sections,
  representative IDs, marker.
- The schedule exists unless Sir declined it, and has a recorded completed run.
- No client-facing surface was touched.

If any item is blocked, say **partial** and name the blocker. Do not say
"built", "done" or "complete".

## Worked examples

**Client matter.** `matter/acme-engagement.md` gets
`commitment_register: true`. Prefix derives to `ACME`, projection to
`note/acme-engagement-commitment-register.md`. Existing delivery records are
enriched with commitment fields, not recreated.

**Household project.** `matter/manor-works.md`, same one-line switch.
Contractor obligations stay external blockers; only Sir's and Alfred's work
becomes owned records.

**Prefix collision.** Two matters both slug to `AC`; the second overrides with
`prefix: ACWORKS`.
